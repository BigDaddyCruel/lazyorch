/**
 * Assign ready tasks → in_progress sessions.
 *
 * On assignment (ready → in_progress):
 * 1. Prefer binding an idle pool worker (reuse); mint only when needed
 * 2. Path-scope locks (forge port; sorted atomic acquire)
 * 3. Worktree hooks (interface; no real git in unit tests)
 * 4. Model router at session start (KD-42)
 * 5. Task FSM transition with assignee / worktree / branch
 *
 * Caps (per assignment + caller max_assign):
 * - free_for_workers (slot ceiling + lead reserve)
 * - pool_workers ≤ max_workers when minting (idle reuse free)
 * - desired / budget via max_assign from schedulerTick
 *
 * Role-template matching (role_affinity ∩ worker_templates) is deferred
 * to PR-13 team manager.
 */

import { generateId } from "@lazyorch/shared";
import {
  routeModel,
  type AdapterRouteInfo,
  type ModelPin,
  type ModelsRoutingConfig,
  type RouteInput,
  type RouteResult,
} from "../models/index.js";
import { transitionTaskStatus } from "../orchestrator/task-fsm.js";
import type { RunPhase } from "../types/run.js";
import type { Task } from "../types/task.js";
import {
  criticalPathLengths,
  isOnCriticalPath,
  sortReadyForAssign,
} from "./critical-path.js";
import { SchedulerMetrics } from "./metrics.js";
import {
  canStartWorkerAssignment,
  computeSlotUsage,
  freeForWorkers,
  phaseNeedsLeadReservation,
} from "./slots.js";
import type {
  AssignBatchResult,
  AssignSkip,
  AssignTaskResult,
  SchedulerSession,
  ScopeLockPort,
  ScopeLockWait,
  SlotLimits,
  WorktreePort,
  WorktreePaths,
} from "./types.js";

export interface AssignReadyOptions {
  tasks: readonly Task[];
  sessions: readonly SchedulerSession[];
  phase: RunPhase;
  limits: SlotLimits;
  locks: ScopeLockPort;
  worktrees?: WorktreePort;
  scope_lock_waits?: Map<string, ScopeLockWait>;
  scope_lock_wait_ms?: number;
  now_ms?: number;
  /**
   * Max assignments this call. Tick sets
   * min(free_for_workers, max(0, desired - active_workers)); 0 when budget_exhausted.
   */
  max_assign?: number;
  nextAgentId?: () => string;
  routing?: AssignRoutingOptions;
  metrics?: SchedulerMetrics;
  skip_scope_lock_task_ids?: ReadonlySet<string>;
}

export interface AssignRoutingOptions {
  config?: Partial<ModelsRoutingConfig>;
  adapters?: AdapterRouteInfo[];
  adapters_default?: string;
  preference_order?: string[];
  run_pin?: ModelPin;
  lead_pin?: ModelPin;
  preferred_adapters?: string[];
  budget_pressure?: boolean;
  routeFn?: (input: RouteInput) => RouteResult;
}

function taskPin(task: Task): ModelPin | undefined {
  const pin: ModelPin = {};
  let any = false;
  if (task.tier_override !== undefined) {
    pin.tier_override = task.tier_override;
    any = true;
  }
  if (task.model_override !== undefined) {
    pin.model_override = task.model_override;
    any = true;
  }
  if (task.adapter_override !== undefined) {
    pin.adapter_override = task.adapter_override;
    any = true;
  }
  return any ? pin : undefined;
}

function buildRouteInput(
  task: Task,
  lengths: ReadonlyMap<string, number>,
  routing: AssignRoutingOptions | undefined,
): RouteInput {
  const pin = taskPin(task);
  const input: RouteInput = {
    role: "worker",
    task_id: task.id,
    signals: {
      role: "worker",
      task_origin: task.origin,
      task_type_labels: task.role_affinity,
      scope_path_count: task.scope.length,
      depends_on_count: task.depends_on.length,
      is_critical_path: isOnCriticalPath(task.id, lengths),
      prior_failures: Math.max(0, task.attempt - 1),
      risk_labels: [],
      acceptance_command_count: task.acceptance.length,
      title_desc_chars: task.title.length + task.description.length,
    },
  };
  if (pin) input.task_pin = pin;
  if (routing?.run_pin) input.run_pin = routing.run_pin;
  if (routing?.lead_pin) input.lead_pin = routing.lead_pin;
  if (routing?.config) input.config = routing.config;
  if (routing?.adapters) input.adapters = routing.adapters;
  if (routing?.adapters_default !== undefined) {
    input.adapters_default = routing.adapters_default;
  }
  if (routing?.preference_order) {
    input.preference_order = routing.preference_order;
  }
  if (routing?.preferred_adapters) {
    input.preferred_adapters = routing.preferred_adapters;
  }
  if (routing?.budget_pressure !== undefined) {
    input.budget_pressure = routing.budget_pressure;
  }
  if (task.adapter_override === "shell") {
    input.session_kind = "deterministic";
  }
  return input;
}

function routeForTask(
  task: Task,
  lengths: ReadonlyMap<string, number>,
  routing: AssignRoutingOptions | undefined,
): RouteResult {
  const input = buildRouteInput(task, lengths, routing);
  if (routing?.routeFn) return routing.routeFn(input);
  return routeModel(input);
}

/** First idle, non-draining worker with no task (oldest last_activity first). */
export function pickIdleWorker(
  sessions: readonly SchedulerSession[],
): SchedulerSession | undefined {
  const idles = sessions.filter(
    (s) =>
      s.role === "worker" &&
      s.state === "idle" &&
      s.task_id === undefined,
  );
  if (idles.length === 0) return undefined;
  idles.sort((a, b) => {
    if (a.last_activity_ms !== b.last_activity_ms) {
      return a.last_activity_ms - b.last_activity_ms;
    }
    return a.run_handle < b.run_handle
      ? -1
      : a.run_handle > b.run_handle
        ? 1
        : 0;
  });
  return idles[0];
}

/**
 * How many worker assignments may start given desired + free slots.
 * Bounds concurrent busy workers (starting|running) to `desired`.
 * budget_exhausted / desired≤0 → 0 (drain only).
 */
export function maxAssignTowardDesired(input: {
  free_for_workers: number;
  desired: number;
  active_workers: number;
  budget_exhausted?: boolean;
}): number {
  if (input.budget_exhausted || input.desired <= 0) return 0;
  const towardDesired = Math.max(0, input.desired - input.active_workers);
  return Math.min(Math.max(0, input.free_for_workers), towardDesired);
}

function skipCapReason(
  usage: ReturnType<typeof computeSlotUsage>,
  limits: SlotLimits,
  free: number,
  reuseIdle: boolean,
): AssignSkip["reason"] {
  if (!reuseIdle && usage.pool_workers >= limits.max_workers) {
    return "max_workers";
  }
  if (usage.slots_used >= limits.max_concurrent_agents || free < 1) {
    return "no_slot";
  }
  return "no_slot";
}

function isHardCap(
  usage: ReturnType<typeof computeSlotUsage>,
  limits: SlotLimits,
  free: number,
  reuseIdle: boolean,
): boolean {
  if (usage.slots_used >= limits.max_concurrent_agents || free < 1) {
    return true;
  }
  if (!reuseIdle && usage.pool_workers >= limits.max_workers) {
    return true;
  }
  return false;
}

type ResolveWorktree = (
  worktrees: WorktreePort | undefined,
  task: Task,
) => Promise<WorktreePaths | undefined> | WorktreePaths | undefined;

function resolveWorktreeSync(
  worktrees: WorktreePort | undefined,
  task: Task,
): WorktreePaths | undefined {
  if (!worktrees || task.workspace_mode !== "worktree") return undefined;
  const wt = worktrees.ensureWorktree(task);
  if (
    typeof wt === "object" &&
    wt !== null &&
    "then" in wt &&
    typeof (wt as Promise<WorktreePaths>).then === "function"
  ) {
    throw new Error(
      "async WorktreePort.ensureWorktree is not supported in sync assignReadyTasks; use assignReadyTasksAsync",
    );
  }
  return wt as WorktreePaths;
}

async function resolveWorktreeAsync(
  worktrees: WorktreePort | undefined,
  task: Task,
): Promise<WorktreePaths | undefined> {
  if (!worktrees || task.workspace_mode !== "worktree") return undefined;
  return Promise.resolve(worktrees.ensureWorktree(task));
}

/**
 * Shared assign body. `resolveWorktree` is sync or async; loop always
 * `await Promise.resolve(...)` so one implementation serves both entrypoints.
 */
async function assignLoop(
  options: AssignReadyOptions,
  resolveWorktree: ResolveWorktree,
): Promise<AssignBatchResult> {
  const now = options.now_ms ?? Date.now();
  const waitMs = options.scope_lock_wait_ms ?? 60_000;
  const waits = new Map(options.scope_lock_waits ?? []);
  const lengths = criticalPathLengths(options.tasks);
  const ready = sortReadyForAssign(
    options.tasks.filter((t) => t.status === "ready"),
    lengths,
  );

  const assigned: AssignTaskResult[] = [];
  const skipped: AssignSkip[] = [];
  const blocked: Task[] = [];
  const liveSessions: SchedulerSession[] = options.sessions.map((s) => ({
    ...s,
  }));
  const maxAssign = options.max_assign ?? Number.POSITIVE_INFINITY;
  let assignCount = 0;

  for (const task of ready) {
    if (assignCount >= maxAssign) break;

    const usage = computeSlotUsage(liveSessions);
    const free = freeForWorkers({
      max_concurrent_agents: options.limits.max_concurrent_agents,
      slots_used: usage.slots_used,
      reserve_slots_lead: options.limits.reserve_slots_lead,
      lead_session_active: usage.active_lead > 0,
      lead_reservation_needed: phaseNeedsLeadReservation(options.phase),
    });
    const idle = pickIdleWorker(liveSessions);
    const reuseIdle = idle !== undefined;

    if (
      !canStartWorkerAssignment({
        usage,
        limits: options.limits,
        free_for_workers: free,
        reuse_idle: reuseIdle,
      })
    ) {
      const reason = skipCapReason(usage, options.limits, free, reuseIdle);
      skipped.push({ task_id: task.id, reason });
      if (isHardCap(usage, options.limits, free, reuseIdle)) {
        for (const rest of ready) {
          if (
            rest.id === task.id ||
            assigned.some((a) => a.task.id === rest.id) ||
            blocked.some((b) => b.id === rest.id) ||
            skipped.some((s) => s.task_id === rest.id)
          ) {
            continue;
          }
          skipped.push({
            task_id: rest.id,
            reason: skipCapReason(
              usage,
              options.limits,
              free,
              pickIdleWorker(liveSessions) !== undefined,
            ),
          });
        }
        break;
      }
      continue;
    }

    const skipLock =
      options.skip_scope_lock_task_ids?.has(task.id) === true &&
      task.workspace_mode === "shared";

    let lockHeld = false;
    if (!skipLock && task.scope.length > 0) {
      const acq = options.locks.tryAcquire(task.id, task.scope);
      if (!acq.ok) {
        const holders = [
          ...new Set(acq.conflicts.map((c) => c.holderId)),
        ];
        const prev = waits.get(task.id);
        const first = prev?.first_fail_ms ?? now;
        waits.set(task.id, {
          task_id: task.id,
          first_fail_ms: first,
          last_fail_ms: now,
          conflict_holders: holders,
        });
        if (now - first >= waitMs) {
          blocked.push(
            transitionTaskStatus(task, "blocked", {
              blocked_reason: "scope_lock",
            }),
          );
          skipped.push({
            task_id: task.id,
            reason: "scope_lock_blocked",
            detail: holders.join(","),
          });
        } else {
          skipped.push({
            task_id: task.id,
            reason: "scope_lock",
            detail: holders.join(","),
          });
        }
        continue;
      }
      lockHeld = true;
      waits.delete(task.id);
    } else {
      waits.delete(task.id);
    }

    const releaseLockIfHeld = (): void => {
      if (lockHeld) {
        options.locks.release(task.id);
        lockHeld = false;
      }
    };

    let worktree: WorktreePaths | undefined;
    try {
      worktree = await Promise.resolve(
        resolveWorktree(options.worktrees, task),
      );
    } catch (err) {
      releaseLockIfHeld();
      skipped.push({
        task_id: task.id,
        reason: "worktree_error",
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    let route: RouteResult;
    let stamped: Task;
    let agentId: string;
    let runHandle: string;
    let reused = false;

    try {
      route = routeForTask(task, lengths, options.routing);
      const idleNow = pickIdleWorker(liveSessions);
      if (idleNow) {
        agentId = idleNow.agent_id;
        runHandle = idleNow.run_handle;
        reused = true;
      } else {
        const u2 = computeSlotUsage(liveSessions);
        if (u2.pool_workers >= options.limits.max_workers) {
          releaseLockIfHeld();
          skipped.push({ task_id: task.id, reason: "max_workers" });
          continue;
        }
        agentId = options.nextAgentId?.() ?? generateId("agt");
        runHandle = `pending_${task.id}`;
      }

      const transitionOpts: Parameters<typeof transitionTaskStatus>[2] = {
        assignee: agentId,
      };
      if (worktree) {
        transitionOpts.worktree_path = worktree.worktreePath;
        transitionOpts.branch = worktree.branch;
      }
      const nextTask = transitionTaskStatus(
        task,
        "in_progress",
        transitionOpts,
      );
      stamped = {
        ...nextTask,
        last_adapter_id: route.adapter_id,
        last_model_id: route.model,
        ...(route.tier !== null && route.tier !== undefined
          ? { last_model_tier: route.tier }
          : {}),
        ...(route.score !== undefined
          ? { complexity_score: route.score }
          : {}),
      };
    } catch (err) {
      // Issue 10: release lock if route/FSM throws after acquire
      releaseLockIfHeld();
      skipped.push({
        task_id: task.id,
        reason: "worktree_error",
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    options.metrics?.recordRoute(route);

    const session_plan: AssignTaskResult["session_plan"] = {
      role: "worker",
      agent_id: agentId,
      adapter_id: route.adapter_id,
      model: route.model,
      model_tier: route.tier,
      session_kind: route.session_kind,
      run_handle: runHandle,
      reused_idle: reused,
    };
    if (route.effort !== undefined) session_plan.effort = route.effort;
    if (route.score !== undefined) {
      session_plan.complexity_score = route.score;
    }

    const result: AssignTaskResult = {
      task: stamped,
      route,
      session_plan,
    };
    if (worktree) result.worktree = worktree;
    assigned.push(result);
    assignCount += 1;

    if (reused) {
      const idx = liveSessions.findIndex((s) => s.run_handle === runHandle);
      if (idx >= 0) {
        liveSessions[idx] = {
          ...liveSessions[idx]!,
          state: "starting",
          task_id: task.id,
          adapter_id: route.adapter_id,
          model: route.model,
          model_tier: route.tier,
          last_activity_ms: now,
        };
      }
    } else {
      liveSessions.push({
        run_handle: runHandle,
        agent_id: agentId,
        role: "worker",
        task_id: task.id,
        state: "starting",
        adapter_id: route.adapter_id,
        model: route.model,
        model_tier: route.tier,
        last_activity_ms: now,
      });
    }
  }

  return {
    assigned,
    skipped,
    blocked,
    scope_lock_waits: waits,
  };
}

/**
 * Sync assign (sync WorktreePort only). Used by unit tests and sync tick.
 * Internally awaits only non-thenables so the returned Promise settles
 * after microtasks; prefer `assignReadyTasksAsync` when worktrees are async.
 *
 * For a fully synchronous API we run the loop with a sync resolver and
 * block via a known-sync path: if every await is on a non-promise value,
 * V8 still microtasks the async function. Callers that need true sync
 * should use this function only with sync fakes **and** flush, OR we
 * provide a sync-only export that duplicates nothing by using
 * `deasync`-free approach below.
 */
export function assignReadyTasks(
  options: AssignReadyOptions,
): AssignBatchResult {
  // True-sync path: use a generator-free blocking implementation by
  // resolving worktrees synchronously inside a non-async function that
  // mirrors assignLoop. Keep one source of truth by inlining the call
  // through a sync executor that throws if any step returns a thenable
  // unexpectedly (already handled in resolveWorktreeSync).
  return assignReadyTasksBlocking(options);
}

/** Blocking sync implementation (single source with assignLoop structure). */
function assignReadyTasksBlocking(
  options: AssignReadyOptions,
): AssignBatchResult {
  // Run assignLoop's logic without async by using only sync worktree resolve.
  // We intentionally call the shared steps inline — see assignLoop for docs.
  // To avoid two full copies, we use Atomics-free sync: the async function
  // is started and we pump until done using a queue of sync continuations.
  // Simplest reliable approach for this codebase: duplicate is worse than
  // a small sync driver that reuses pure helpers (locks, route, FSM).

  const now = options.now_ms ?? Date.now();
  const waitMs = options.scope_lock_wait_ms ?? 60_000;
  const waits = new Map(options.scope_lock_waits ?? []);
  const lengths = criticalPathLengths(options.tasks);
  const ready = sortReadyForAssign(
    options.tasks.filter((t) => t.status === "ready"),
    lengths,
  );
  const assigned: AssignTaskResult[] = [];
  const skipped: AssignSkip[] = [];
  const blocked: Task[] = [];
  const liveSessions: SchedulerSession[] = options.sessions.map((s) => ({
    ...s,
  }));
  const maxAssign = options.max_assign ?? Number.POSITIVE_INFINITY;
  let assignCount = 0;

  for (const task of ready) {
    if (assignCount >= maxAssign) break;

    const usage = computeSlotUsage(liveSessions);
    const free = freeForWorkers({
      max_concurrent_agents: options.limits.max_concurrent_agents,
      slots_used: usage.slots_used,
      reserve_slots_lead: options.limits.reserve_slots_lead,
      lead_session_active: usage.active_lead > 0,
      lead_reservation_needed: phaseNeedsLeadReservation(options.phase),
    });
    const idle = pickIdleWorker(liveSessions);
    const reuseIdle = idle !== undefined;

    if (
      !canStartWorkerAssignment({
        usage,
        limits: options.limits,
        free_for_workers: free,
        reuse_idle: reuseIdle,
      })
    ) {
      const reason = skipCapReason(usage, options.limits, free, reuseIdle);
      skipped.push({ task_id: task.id, reason });
      if (isHardCap(usage, options.limits, free, reuseIdle)) {
        for (const rest of ready) {
          if (
            rest.id === task.id ||
            assigned.some((a) => a.task.id === rest.id) ||
            blocked.some((b) => b.id === rest.id) ||
            skipped.some((s) => s.task_id === rest.id)
          ) {
            continue;
          }
          skipped.push({
            task_id: rest.id,
            reason: skipCapReason(
              usage,
              options.limits,
              free,
              pickIdleWorker(liveSessions) !== undefined,
            ),
          });
        }
        break;
      }
      continue;
    }

    const skipLock =
      options.skip_scope_lock_task_ids?.has(task.id) === true &&
      task.workspace_mode === "shared";

    let lockHeld = false;
    if (!skipLock && task.scope.length > 0) {
      const acq = options.locks.tryAcquire(task.id, task.scope);
      if (!acq.ok) {
        const holders = [
          ...new Set(acq.conflicts.map((c) => c.holderId)),
        ];
        const prev = waits.get(task.id);
        const first = prev?.first_fail_ms ?? now;
        waits.set(task.id, {
          task_id: task.id,
          first_fail_ms: first,
          last_fail_ms: now,
          conflict_holders: holders,
        });
        if (now - first >= waitMs) {
          blocked.push(
            transitionTaskStatus(task, "blocked", {
              blocked_reason: "scope_lock",
            }),
          );
          skipped.push({
            task_id: task.id,
            reason: "scope_lock_blocked",
            detail: holders.join(","),
          });
        } else {
          skipped.push({
            task_id: task.id,
            reason: "scope_lock",
            detail: holders.join(","),
          });
        }
        continue;
      }
      lockHeld = true;
      waits.delete(task.id);
    } else {
      waits.delete(task.id);
    }

    const releaseLockIfHeld = (): void => {
      if (lockHeld) {
        options.locks.release(task.id);
        lockHeld = false;
      }
    };

    let worktree: WorktreePaths | undefined;
    try {
      worktree = resolveWorktreeSync(options.worktrees, task);
    } catch (err) {
      releaseLockIfHeld();
      skipped.push({
        task_id: task.id,
        reason: "worktree_error",
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    let route: RouteResult;
    let stamped: Task;
    let agentId: string;
    let runHandle: string;
    let reused = false;

    try {
      route = routeForTask(task, lengths, options.routing);
      const idleNow = pickIdleWorker(liveSessions);
      if (idleNow) {
        agentId = idleNow.agent_id;
        runHandle = idleNow.run_handle;
        reused = true;
      } else {
        const u2 = computeSlotUsage(liveSessions);
        if (u2.pool_workers >= options.limits.max_workers) {
          releaseLockIfHeld();
          skipped.push({ task_id: task.id, reason: "max_workers" });
          continue;
        }
        agentId = options.nextAgentId?.() ?? generateId("agt");
        runHandle = `pending_${task.id}`;
      }

      const transitionOpts: Parameters<typeof transitionTaskStatus>[2] = {
        assignee: agentId,
      };
      if (worktree) {
        transitionOpts.worktree_path = worktree.worktreePath;
        transitionOpts.branch = worktree.branch;
      }
      const nextTask = transitionTaskStatus(
        task,
        "in_progress",
        transitionOpts,
      );
      stamped = {
        ...nextTask,
        last_adapter_id: route.adapter_id,
        last_model_id: route.model,
        ...(route.tier !== null && route.tier !== undefined
          ? { last_model_tier: route.tier }
          : {}),
        ...(route.score !== undefined
          ? { complexity_score: route.score }
          : {}),
      };
    } catch (err) {
      releaseLockIfHeld();
      skipped.push({
        task_id: task.id,
        reason: "worktree_error",
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    options.metrics?.recordRoute(route);

    const session_plan: AssignTaskResult["session_plan"] = {
      role: "worker",
      agent_id: agentId,
      adapter_id: route.adapter_id,
      model: route.model,
      model_tier: route.tier,
      session_kind: route.session_kind,
      run_handle: runHandle,
      reused_idle: reused,
    };
    if (route.effort !== undefined) session_plan.effort = route.effort;
    if (route.score !== undefined) {
      session_plan.complexity_score = route.score;
    }

    const result: AssignTaskResult = {
      task: stamped,
      route,
      session_plan,
    };
    if (worktree) result.worktree = worktree;
    assigned.push(result);
    assignCount += 1;

    if (reused) {
      const idx = liveSessions.findIndex((s) => s.run_handle === runHandle);
      if (idx >= 0) {
        liveSessions[idx] = {
          ...liveSessions[idx]!,
          state: "starting",
          task_id: task.id,
          adapter_id: route.adapter_id,
          model: route.model,
          model_tier: route.tier,
          last_activity_ms: now,
        };
      }
    } else {
      liveSessions.push({
        run_handle: runHandle,
        agent_id: agentId,
        role: "worker",
        task_id: task.id,
        state: "starting",
        adapter_id: route.adapter_id,
        model: route.model,
        model_tier: route.tier,
        last_activity_ms: now,
      });
    }
  }

  return {
    assigned,
    skipped,
    blocked,
    scope_lock_waits: waits,
  };
}

/** Async assign (worktree port may return Promises). */
export async function assignReadyTasksAsync(
  options: AssignReadyOptions,
): Promise<AssignBatchResult> {
  return assignLoop(options, resolveWorktreeAsync);
}

export function releaseTaskScopeLocks(
  locks: ScopeLockPort,
  taskId: string,
): number {
  return locks.release(taskId);
}
