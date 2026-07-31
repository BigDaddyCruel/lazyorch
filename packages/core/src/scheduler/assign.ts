/**
 * Assign ready tasks → in_progress sessions.
 *
 * On assignment (ready → in_progress):
 * 1. Path-scope locks (forge port; sorted atomic acquire)
 * 2. Worktree hooks (interface; no real git in unit tests)
 * 3. Model router at session start (KD-42; elastic spawn routes here)
 * 4. Task FSM transition with assignee / worktree / branch
 *
 * Priority among ready tasks: critical path → priority → id.
 * Slot scarcity: only workers here (lead/reviewer/QA assignment is separate).
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
  canStartSession,
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

function isThenable<T>(v: T | Promise<T>): v is Promise<T> {
  return (
    typeof v === "object" &&
    v !== null &&
    "then" in v &&
    typeof (v as Promise<T>).then === "function"
  );
}

export interface AssignReadyOptions {
  tasks: readonly Task[];
  sessions: readonly SchedulerSession[];
  phase: RunPhase;
  limits: SlotLimits;
  locks: ScopeLockPort;
  /** Optional; when omitted, worktree_path/branch stay unset. */
  worktrees?: WorktreePort;
  /** Existing scope-lock wait map (mutated copy returned). */
  scope_lock_waits?: Map<string, ScopeLockWait>;
  scope_lock_wait_ms?: number;
  now_ms?: number;
  /** Max assignments this call (default = free worker slots). */
  max_assign?: number;
  /**
   * Agent id factory for the synthetic worker assignee.
   * Default: generateId("agt").
   */
  nextAgentId?: () => string;
  /** Model router inputs shared across assignments. */
  routing?: AssignRoutingOptions;
  metrics?: SchedulerMetrics;
  /**
   * Task ids allowed to skip scope locks (plan freeze overlapping_scopes
   * with concurrent: true + workspace_mode shared).
   */
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
  /**
   * Optional full override of routeModel (tests inject fixed routes).
   * When provided, built-in router is skipped.
   */
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
  // Deterministic shell path when adapter_override is shell
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
  if (routing?.routeFn) {
    return routing.routeFn(input);
  }
  return routeModel(input);
}

/**
 * Assign as many ready tasks as worker slots allow.
 * Pure-ish: mutates only via returned tasks + lock port side effects.
 */
export function assignReadyTasks(
  options: AssignReadyOptions,
): AssignBatchResult {
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

  // Working copy of sessions for slot math within this batch
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

    if (
      !canStartSession({
        role: "worker",
        usage,
        limits: options.limits,
        free_for_workers: free,
      })
    ) {
      skipped.push({
        task_id: task.id,
        reason:
          usage.active_workers >= options.limits.max_workers
            ? "max_workers"
            : "no_slot",
      });
      // Later tasks may still not fit; continue only if higher-priority
      // ones failed for other reasons — if we're slot-capped, stop.
      if (
        usage.slots_used >= options.limits.max_concurrent_agents ||
        free < 1 ||
        usage.active_workers >= options.limits.max_workers
      ) {
        // Mark remaining ready as skipped for observability
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
            reason:
              usage.active_workers >= options.limits.max_workers
                ? "max_workers"
                : "no_slot",
          });
        }
        break;
      }
      continue;
    }

    const skipLock =
      options.skip_scope_lock_task_ids?.has(task.id) === true &&
      task.workspace_mode === "shared";

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
          const blockedTask = transitionTaskStatus(task, "blocked", {
            blocked_reason: "scope_lock",
          });
          blocked.push(blockedTask);
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
      // Lock acquired — clear wait
      waits.delete(task.id);
    } else {
      waits.delete(task.id);
    }

    let worktree: WorktreePaths | undefined;
    if (options.worktrees && task.workspace_mode === "worktree") {
      try {
        const wt = options.worktrees.ensureWorktree(task);
        if (isThenable(wt)) {
          // Sync path only accepts sync WorktreePort (unit tests / fakes).
          // Daemon ticks should call assignReadyTasksAsync.
          throw new Error(
            "async WorktreePort.ensureWorktree is not supported in sync assignReadyTasks; use assignReadyTasksAsync",
          );
        }
        worktree = wt;
      } catch (err) {
        // Release lock on worktree failure
        if (!skipLock && task.scope.length > 0) {
          options.locks.release(task.id);
        }
        skipped.push({
          task_id: task.id,
          reason: "worktree_error",
          detail: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
    }

    const route = routeForTask(task, lengths, options.routing);
    options.metrics?.recordRoute(route);

    const agentId = options.nextAgentId?.() ?? generateId("agt");

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

    // Stamp last route observability fields
    const stamped: Task = {
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

    const session_plan: AssignTaskResult["session_plan"] = {
      role: "worker",
      agent_id: agentId,
      adapter_id: route.adapter_id,
      model: route.model,
      model_tier: route.tier,
      session_kind: route.session_kind,
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

    // Reflect new worker session for subsequent slot math
    liveSessions.push({
      run_handle: `pending_${task.id}`,
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

  return {
    assigned,
    skipped,
    blocked,
    scope_lock_waits: waits,
  };
}

/**
 * Async variant when worktree port may return Promises.
 * Prefer this from daemon ticks; unit tests use the sync path with fakes.
 */
export async function assignReadyTasksAsync(
  options: AssignReadyOptions,
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

    if (
      !canStartSession({
        role: "worker",
        usage,
        limits: options.limits,
        free_for_workers: free,
      })
    ) {
      const reason =
        usage.active_workers >= options.limits.max_workers
          ? "max_workers"
          : "no_slot";
      skipped.push({ task_id: task.id, reason });
      if (
        usage.slots_used >= options.limits.max_concurrent_agents ||
        free < 1 ||
        usage.active_workers >= options.limits.max_workers
      ) {
        for (const rest of ready) {
          if (
            rest.id === task.id ||
            assigned.some((a) => a.task.id === rest.id) ||
            blocked.some((b) => b.id === rest.id) ||
            skipped.some((s) => s.task_id === rest.id)
          ) {
            continue;
          }
          skipped.push({ task_id: rest.id, reason });
        }
        break;
      }
      continue;
    }

    const skipLock =
      options.skip_scope_lock_task_ids?.has(task.id) === true &&
      task.workspace_mode === "shared";

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
      waits.delete(task.id);
    } else {
      waits.delete(task.id);
    }

    let worktree: WorktreePaths | undefined;
    if (options.worktrees && task.workspace_mode === "worktree") {
      try {
        worktree = await Promise.resolve(
          options.worktrees.ensureWorktree(task),
        );
      } catch (err) {
        if (!skipLock && task.scope.length > 0) {
          options.locks.release(task.id);
        }
        skipped.push({
          task_id: task.id,
          reason: "worktree_error",
          detail: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
    }

    const route = routeForTask(task, lengths, options.routing);
    options.metrics?.recordRoute(route);

    const agentId = options.nextAgentId?.() ?? generateId("agt");
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
    const stamped: Task = {
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

    const session_plan: AssignTaskResult["session_plan"] = {
      role: "worker",
      agent_id: agentId,
      adapter_id: route.adapter_id,
      model: route.model,
      model_tier: route.tier,
      session_kind: route.session_kind,
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

    liveSessions.push({
      run_handle: `pending_${task.id}`,
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

  return {
    assigned,
    skipped,
    blocked,
    scope_lock_waits: waits,
  };
}

/**
 * Release path-scope locks for a task (terminal states after integrate/abandon).
 * Callers invoke when task reaches done | failed | cancelled.
 */
export function releaseTaskScopeLocks(
  locks: ScopeLockPort,
  taskId: string,
): number {
  return locks.release(taskId);
}
