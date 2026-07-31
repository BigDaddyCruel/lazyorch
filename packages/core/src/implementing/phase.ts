/**
 * Implementing phase orchestration tick.
 *
 * Assign / worker / review / integrate loop using:
 * - scheduler (assign + path-scope locks + router escalate on retry)
 * - task FSM
 * - forge integrate under global mutex (KD-33/34) — no lead agent slot
 * - replan hooks (prepareReplan / resumeAfterReplan from planning)
 * - terminal failed policy (KD-36)
 *
 * Does not implement full GitHub PR/CILoop (PR-17).
 */

import { generateId } from "@lazyorch/shared";
import { depsSatisfied } from "../dag.js";
import {
  defaultAdaptersForRouting,
  routeModel,
  type RouteResult,
} from "../models/index.js";
import {
  canExitImplementing,
  exitImplementing,
  transitionTaskStatus,
} from "../orchestrator/index.js";
import {
  prepareReplan,
  resumeAfterReplan,
  type PrepareReplanOptions,
  type PrepareReplanResult,
  type ResumeAfterReplanOptions,
} from "../planning/replan.js";
import {
  defaultSchedulerConfig,
  releaseTaskScopeLocks,
  schedulerTickAsync,
  type AssignRoutingOptions,
  type SchedulerConfig,
  type SchedulerRuntimeState,
  type SchedulerSession,
  type SchedulerTickResult,
  type ScopeLockPort,
  type WorktreePort,
} from "../scheduler/index.js";
import {
  canStartReviewerSession,
  preferredAdaptersForRole,
} from "../team/index.js";
import type { Gate } from "../types/gate.js";
import type { Plan } from "../types/plan.js";
import type { Run } from "../types/run.js";
import type { Task } from "../types/task.js";
import { drainIntegrateQueue } from "./integrate.js";
import {
  applyReviewDecision,
  applyWorkerOutcome,
  recoverIntegrateConflict,
} from "./outcomes.js";
import type {
  ForgeIntegratePort,
  IntegrationMutexPort,
  ReviewerSessionPort,
  WorkerSessionPort,
} from "./ports.js";
import {
  applyConflictStormPolicy,
  applyTerminalFailedPolicy,
  type OnTaskTerminalFailed,
  type TerminalFailedPolicy,
} from "./terminal-failed.js";

export interface ImplementingTickParams {
  run: Run;
  tasks: readonly Task[];
  runtime: SchedulerRuntimeState;
  locks: ScopeLockPort;
  mutex: IntegrationMutexPort;
  forge: ForgeIntegratePort;
  /** Optional: when set, drives in_progress workers this tick. */
  worker?: WorkerSessionPort;
  /** Optional: when set, drives review tasks this tick. */
  reviewer?: ReviewerSessionPort;
  worktrees?: WorktreePort;
  config?: SchedulerConfig;
  routing?: AssignRoutingOptions;
  cwd?: string;
  repo_root?: string;
  /** Auto-recover integrate_conflict → ready (default true). */
  auto_recover_integrate_conflict?: boolean;
  /** Process worker outcomes this tick (default true when worker set). */
  run_workers?: boolean;
  /** Process reviews this tick (default true when reviewer set). */
  run_reviews?: boolean;
  /** Drain integrate queue this tick (default true). */
  run_integrates?: boolean;
  /** Max integrates this tick (default unlimited). */
  max_integrates?: number;
  /** Max reviews this tick. */
  max_reviews?: number;
  /** Max workers to run this tick. */
  max_workers?: number;
  terminal_failed?: TerminalFailedPolicy;
  /**
   * Pending/open gates for this run (KD-36 idempotency).
   * Also merged into policy.existing_gates.
   */
  existing_gates?: readonly Gate[];
  /** Try Implementing exit when predicate holds (default false — caller opts in). */
  try_exit?: boolean;
  now_ms?: number;
  now?: () => string;
  nextAgentId?: () => string;
  nextGateId?: () => string;
  budget_exhausted?: boolean;
  pause_elasticity?: boolean;
  /** Promote todo→ready when deps done (default true). */
  promote_ready?: boolean;
}

export interface ImplementingTickResult {
  run: Run;
  tasks: Task[];
  runtime: SchedulerRuntimeState;
  scheduler?: SchedulerTickResult;
  worker_outcomes: Array<{ task_id: string; kind: string }>;
  review_outcomes: Array<{ task_id: string; decision: string }>;
  integrate_results: Array<{
    task_id: string;
    status: string;
    deferred?: boolean;
  }>;
  recovered_conflict_ids: string[];
  /** Conflict storm task ids left blocked at max_attempts. */
  conflict_storm_ids: string[];
  gates: Gate[];
  escalated_task_ids: string[];
  exited: boolean;
}

function promoteTodos(tasks: readonly Task[]): Task[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return tasks.map((t) => {
    if (t.status !== "todo") return t;
    if (!depsSatisfied(t, byId)) return t;
    return transitionTaskStatus(t, "ready");
  });
}

function replaceTasks(
  tasks: readonly Task[],
  updates: ReadonlyMap<string, Task>,
): Task[] {
  return tasks.map((t) => updates.get(t.id) ?? t);
}

function countHoldingSlots(sessions: readonly SchedulerSession[]): number {
  return sessions.filter(
    (s) => s.state === "running" || s.state === "starting",
  ).length;
}

function countActiveReviewers(sessions: readonly SchedulerSession[]): number {
  return sessions.filter(
    (s) =>
      s.role === "reviewer" &&
      (s.state === "running" || s.state === "starting"),
  ).length;
}

/**
 * One Implementing-phase orchestration tick.
 */
export async function implementingTick(
  params: ImplementingTickParams,
): Promise<ImplementingTickResult> {
  if (params.run.phase !== "Implementing") {
    throw new Error(
      `implementingTick requires phase Implementing, got ${params.run.phase}`,
    );
  }

  let run = params.run;
  let tasks = [...params.tasks];
  let runtime = {
    ...params.runtime,
    sessions: [...params.runtime.sessions],
    scope_lock_waits: new Map(params.runtime.scope_lock_waits),
  };
  const gates: Gate[] = [];
  const worker_outcomes: ImplementingTickResult["worker_outcomes"] = [];
  const review_outcomes: ImplementingTickResult["review_outcomes"] = [];
  const integrate_results: ImplementingTickResult["integrate_results"] = [];
  const recovered_conflict_ids: string[] = [];
  const conflict_storm_ids: string[] = [];
  const escalated_task_ids: string[] = [];
  const nowMs = params.now_ms ?? Date.now();
  const cwd = params.cwd ?? params.repo_root ?? ".";
  const config = params.config ?? defaultSchedulerConfig();
  const existingGates: Gate[] = [
    ...(params.existing_gates ?? []),
    ...(params.terminal_failed?.existing_gates ?? []),
  ];

  // 1. Promote todo → ready
  if (params.promote_ready !== false) {
    tasks = promoteTodos(tasks);
  }

  // 2. Recover integrate_conflict → ready (locks retained), or storm at max
  if (params.auto_recover_integrate_conflict !== false) {
    const updates = new Map<string, Task>();
    for (const t of tasks) {
      if (
        t.status === "blocked" &&
        t.blocked_reason === "integrate_conflict"
      ) {
        const result = recoverIntegrateConflict(t);
        updates.set(t.id, result.task);
        if (result.recovered) {
          recovered_conflict_ids.push(t.id);
        } else if (result.storm) {
          conflict_storm_ids.push(t.id);
        }
      }
    }
    if (updates.size > 0) tasks = replaceTasks(tasks, updates);

    if (conflict_storm_ids.length > 0) {
      const storm = applyConflictStormPolicy(run, conflict_storm_ids, {
        existing_gates: existingGates,
        ...(params.terminal_failed?.already_escalated_task_ids !== undefined
          ? {
              already_escalated_task_ids:
                params.terminal_failed.already_escalated_task_ids,
            }
          : {}),
        ...(params.now !== undefined ? { now: params.now } : {}),
        ...(params.nextGateId !== undefined
          ? { nextGateId: params.nextGateId }
          : {}),
      });
      gates.push(...storm.gates);
      escalated_task_ids.push(...storm.escalated_task_ids);
      existingGates.push(...storm.gates);
    }
  }

  // 3. Scheduler assign (locks + router with escalate on retry)
  const tickIn = {
    tasks,
    phase: run.phase,
    runtime,
    config,
    locks: params.locks,
    now_ms: nowMs,
    ...(params.worktrees !== undefined ? { worktrees: params.worktrees } : {}),
    ...(params.routing !== undefined ? { routing: params.routing } : {}),
    ...(params.budget_exhausted !== undefined
      ? { budget_exhausted: params.budget_exhausted }
      : {}),
    ...(params.pause_elasticity !== undefined
      ? { pause_elasticity: params.pause_elasticity }
      : {}),
  };
  const scheduler = await schedulerTickAsync(tickIn);

  // Apply assign results into task list + sessions
  const assignUpdates = new Map<string, Task>();
  for (const a of scheduler.assign.assigned) {
    assignUpdates.set(a.task.id, a.task);
  }
  for (const b of scheduler.assign.blocked) {
    assignUpdates.set(b.id, b);
  }
  tasks = replaceTasks(tasks, assignUpdates);
  // schedulerTickAsync already applied assign into runtime.sessions
  runtime = {
    ...scheduler.runtime,
    sessions: [...scheduler.runtime.sessions],
    scope_lock_waits: new Map(scheduler.runtime.scope_lock_waits),
  };

  // 4. Run workers for in_progress tasks
  if (params.worker && params.run_workers !== false) {
    const inProgress = tasks.filter((t) => t.status === "in_progress");
    const maxW = params.max_workers ?? inProgress.length;
    let count = 0;
    const updates = new Map<string, Task>();
    for (const t of inProgress) {
      if (count >= maxW) break;
      const session = runtime.sessions.find(
        (s) => s.task_id === t.id && s.role === "worker",
      );
      const outcome = await params.worker.run({
        task: t,
        agent_id: t.assignee ?? session?.agent_id ?? "agt_unknown",
        adapter_id: t.last_adapter_id ?? session?.adapter_id ?? "claude",
        model: t.last_model_id ?? session?.model ?? "unknown",
        model_tier:
          t.last_model_tier ??
          (session?.model_tier as Task["last_model_tier"]) ??
          null,
        session_kind: "llm",
        ...(t.worktree_path !== undefined
          ? { worktree_path: t.worktree_path }
          : {}),
        ...(t.branch !== undefined ? { branch: t.branch } : {}),
        integrate_conflict_rework: t.integrate_error !== undefined,
        cwd,
        ...(session?.run_handle !== undefined
          ? { run_handle: session.run_handle }
          : {}),
      });
      const next = applyWorkerOutcome(t, outcome);
      updates.set(t.id, next);
      worker_outcomes.push({ task_id: t.id, kind: outcome.kind });

      // Path-scope locks release on terminal failed / cancelled (KD-15)
      if (next.status === "failed" || next.status === "cancelled") {
        releaseTaskScopeLocks(params.locks, t.id);
      }

      // Free worker session slot when task leaves in_progress
      if (next.status !== "in_progress" && session) {
        runtime = {
          ...runtime,
          sessions: runtime.sessions.map((s) => {
            if (s.run_handle !== session.run_handle) return s;
            const { task_id: _tid, ...rest } = s;
            return { ...rest, state: "idle" as const };
          }),
        };
      }
      count += 1;
    }
    if (updates.size > 0) tasks = replaceTasks(tasks, updates);
  }

  // 5. Run reviewers for review queue — respect max_reviewers + free slots
  if (params.reviewer && params.run_reviews !== false) {
    const reviewQueue = tasks.filter((t) => t.status === "review");
    const maxR = params.max_reviews ?? reviewQueue.length;
    const updates = new Map<string, Task>();
    const preferred = preferredAdaptersForRole("reviewer");
    let count = 0;

    for (const t of reviewQueue) {
      if (count >= maxR) break;

      const activeReviewers = countActiveReviewers(runtime.sessions);
      const freeSlots = Math.max(
        0,
        config.scheduling.max_concurrent_agents -
          countHoldingSlots(runtime.sessions),
      );
      const canStart = canStartReviewerSession({
        review_queue_count: reviewQueue.length - count,
        active_reviewers: activeReviewers,
        max_reviewers: config.team.max_reviewers,
        free_slots: freeSlots,
        mode_allows:
          config.team.mode !== "solo" || config.team.max_reviewers > 0,
      });
      if (!canStart) break;

      // Route reviewer (ephemeral)
      const route: RouteResult = routeModel({
        role: "reviewer",
        task_id: t.id,
        preferred_adapters: [...preferred],
        adapters: params.routing?.adapters ?? defaultAdaptersForRouting(),
        ...(params.routing?.config !== undefined
          ? { config: params.routing.config }
          : {}),
      });
      const agentId = params.nextAgentId?.() ?? generateId("agt");
      const runHandle = `review_${t.id}_${nowMs}_${count}`;

      // Register transient reviewer session so caps/free slots update (Issue 8)
      const reviewerSession: SchedulerSession = {
        run_handle: runHandle,
        agent_id: agentId,
        role: "reviewer",
        task_id: t.id,
        state: "running",
        adapter_id: route.adapter_id,
        model: route.model,
        model_tier: route.tier,
        last_activity_ms: nowMs,
      };
      runtime = {
        ...runtime,
        sessions: [...runtime.sessions, reviewerSession],
      };

      const outcome = await params.reviewer.run({
        task: t,
        agent_id: agentId,
        adapter_id: route.adapter_id,
        model: route.model,
        model_tier: route.tier,
        session_kind: route.session_kind,
        ...(route.effort !== undefined ? { effort: route.effort } : {}),
        cwd,
        run_handle: runHandle,
      });
      const next = applyReviewDecision(t, outcome);
      updates.set(t.id, next);
      review_outcomes.push({
        task_id: t.id,
        decision: outcome.decision,
      });

      // Release locks on terminal failed from review reject exhaustion
      if (next.status === "failed" || next.status === "cancelled") {
        releaseTaskScopeLocks(params.locks, t.id);
      }

      // Ephemeral reviewer exits after outcome (clean exit)
      runtime = {
        ...runtime,
        sessions: runtime.sessions.filter((s) => s.run_handle !== runHandle),
      };
      count += 1;
    }
    if (updates.size > 0) tasks = replaceTasks(tasks, updates);
  }

  // 6. Drain integrate queue under mutex (no agent slot)
  if (params.run_integrates !== false) {
    const drained = await drainIntegrateQueue({
      run,
      tasks,
      forge: params.forge,
      mutex: params.mutex,
      locks: params.locks,
      ...(params.repo_root !== undefined
        ? { repo_root: params.repo_root }
        : {}),
      ...(run.feature_branch !== undefined
        ? { feature_branch: run.feature_branch }
        : {}),
      ...(params.max_integrates !== undefined
        ? { max: params.max_integrates }
        : {}),
    });
    run = drained.run;
    tasks = drained.tasks;
    for (const r of drained.results) {
      integrate_results.push({
        task_id: r.task.id,
        status: r.deferred ? "deferred" : r.integrate.status,
        ...(r.deferred ? { deferred: true } : {}),
      });
    }
  }

  // 7. Terminal failed policy (KD-36) — idempotent vs existing gates
  const tfPolicy: TerminalFailedPolicy = {
    on_task_terminal_failed:
      (config.scheduling.on_task_terminal_failed as OnTaskTerminalFailed) ??
      "gate",
    failed_escalation_ms: config.scheduling.failed_escalation_ms ?? 0,
    now_ms: nowMs,
    existing_gates: existingGates,
    ...(params.now !== undefined ? { now: params.now } : {}),
    ...(params.nextGateId !== undefined
      ? { nextGateId: params.nextGateId }
      : {}),
    ...(params.terminal_failed ?? {}),
  };
  // Ensure existing_gates from params win merge with storm gates this tick
  tfPolicy.existing_gates = existingGates;

  const terminal = applyTerminalFailedPolicy(run, tasks, tfPolicy);
  run = terminal.run;
  gates.push(...terminal.gates);
  escalated_task_ids.push(...terminal.escalated_task_ids);

  // 8. Optional exit
  let exited = false;
  if (params.try_exit && canExitImplementing(run, tasks)) {
    run = exitImplementing(run, tasks);
    exited = true;
  }

  return {
    run,
    tasks,
    runtime,
    scheduler,
    worker_outcomes,
    review_outcomes,
    integrate_results,
    recovered_conflict_ids,
    conflict_storm_ids,
    gates,
    escalated_task_ids,
    exited,
  };
}

// ---------------------------------------------------------------------------
// Replan protocol hooks (thin wrappers for implementing phase callers)
// ---------------------------------------------------------------------------

export {
  prepareReplan,
  resumeAfterReplan,
  type PrepareReplanOptions,
  type PrepareReplanResult,
  type ResumeAfterReplanOptions,
};

/**
 * Convenience: prepare mid-run replan from Implementing.
 * Releases scope locks for cancelled (superseded) tasks when locks provided.
 */
export function prepareImplementingReplan(
  run: Run,
  tasks: readonly Task[],
  newPlanRevisionId: string,
  options: PrepareReplanOptions & { locks?: ScopeLockPort } = {},
  priorPlan?: Plan,
): PrepareReplanResult {
  const { locks, ...replanOpts } = options;
  const result = prepareReplan(
    run,
    tasks,
    newPlanRevisionId,
    replanOpts,
    priorPlan,
  );
  if (locks) {
    for (const id of result.cancelled_ids) {
      locks.release(id);
    }
  }
  return result;
}

/**
 * Resume after replan freeze (PlanConsensus → Implementing).
 * New tasks should be materialized by caller via materializePlanTasks.
 */
export function resumeImplementingAfterReplan(
  run: Run,
  options: ResumeAfterReplanOptions,
): Run {
  return resumeAfterReplan(run, options);
}
