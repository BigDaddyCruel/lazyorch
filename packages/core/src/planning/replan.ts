import { transitionRunPhase } from "../orchestrator/run-fsm.js";
import { transitionTaskStatus } from "../orchestrator/task-fsm.js";
import type { Plan } from "../types/plan.js";
import type { Run } from "../types/run.js";
import type { Task } from "../types/task.js";

export class ReplanError extends Error {
  readonly code:
    | "invalid_phase"
    | "integrating_mutex"
    | "missing_plan_rev";

  constructor(code: ReplanError["code"], message: string) {
    super(message);
    this.name = "ReplanError";
    this.code = code;
  }
}

/** Statuses cancelled (superseded) during mid-run replan. */
const SUPERSEDE_STATUSES: ReadonlySet<Task["status"]> = new Set([
  "todo",
  "ready",
  "in_progress",
  "review",
  "integrating",
  "blocked",
  "failed",
]);

export interface SupersedeTasksResult {
  tasks: Task[];
  cancelled_ids: string[];
  preserved_done_ids: string[];
  already_cancelled_ids: string[];
}

/**
 * Mark non-done open tasks cancelled with `superseded_by_plan`.
 * `done` tasks are preserved; already `cancelled` left as-is.
 *
 * Pure: does not touch run phase or path-scope locks (caller releases locks).
 */
export function supersedeOpenTasks(
  tasks: readonly Task[],
  newPlanRevisionId: string,
): SupersedeTasksResult {
  if (!newPlanRevisionId || newPlanRevisionId.trim() === "") {
    throw new ReplanError(
      "missing_plan_rev",
      "superseded_by_plan requires a non-empty plan revision id",
    );
  }

  const cancelled_ids: string[] = [];
  const preserved_done_ids: string[] = [];
  const already_cancelled_ids: string[] = [];

  const next = tasks.map((t) => {
    if (t.status === "done") {
      preserved_done_ids.push(t.id);
      return t;
    }
    if (t.status === "cancelled") {
      already_cancelled_ids.push(t.id);
      return t;
    }
    if (SUPERSEDE_STATUSES.has(t.status)) {
      const cancelled = transitionTaskStatus(t, "cancelled");
      cancelled_ids.push(t.id);
      return {
        ...cancelled,
        superseded_by_plan: newPlanRevisionId,
      };
    }
    return t;
  });

  return {
    tasks: next,
    cancelled_ids,
    preserved_done_ids,
    already_cancelled_ids,
  };
}

export interface PrepareReplanOptions {
  /**
   * When true (default), refuse if any task is still `integrating`
   * (integration mutex / half-applied merge — design replan step 3).
   */
  reject_if_integrating?: boolean;
  /** ISO-8601; defaults to now */
  updated_at?: string;
}

export interface PrepareReplanResult {
  run: Run;
  tasks: Task[];
  cancelled_ids: string[];
  preserved_done_ids: string[];
  /** Prior plan marked superseded when provided. */
  prior_plan?: Plan;
}

/**
 * Mid-run replan signal hook:
 * 1. Optionally reject while integrates are in flight
 * 2. Supersede open tasks with new plan revision id
 * 3. Transition run Implementing → Planning
 * 4. Mark prior plan status superseded
 *
 * Snapshot / worktree / lock release are orchestration concerns outside this pure hook.
 */
export function prepareReplan(
  run: Run,
  tasks: readonly Task[],
  newPlanRevisionId: string,
  options: PrepareReplanOptions = {},
  priorPlan?: Plan,
): PrepareReplanResult {
  const rejectIfIntegrating = options.reject_if_integrating ?? true;

  if (run.phase !== "Implementing") {
    throw new ReplanError(
      "invalid_phase",
      `prepareReplan requires phase Implementing, got ${run.phase}`,
    );
  }

  if (rejectIfIntegrating && tasks.some((t) => t.status === "integrating")) {
    throw new ReplanError(
      "integrating_mutex",
      "Cannot replan while a task is integrating; drain or abort integrates first",
    );
  }

  const superseded = supersedeOpenTasks(tasks, newPlanRevisionId);
  const ts = options.updated_at ?? new Date().toISOString();
  const nextRun = transitionRunPhase(run, "Planning", { updated_at: ts });

  let prior_plan: Plan | undefined;
  if (priorPlan !== undefined) {
    prior_plan = {
      ...priorPlan,
      status: "superseded",
      updated_at: ts,
    };
  }

  const result: PrepareReplanResult = {
    run: nextRun,
    tasks: superseded.tasks,
    cancelled_ids: superseded.cancelled_ids,
    preserved_done_ids: superseded.preserved_done_ids,
  };
  if (prior_plan !== undefined) {
    result.prior_plan = prior_plan;
  }
  return result;
}

/**
 * Resume after replan freeze: PlanConsensus → Implementing.
 * Human plan_approve gate is the caller's responsibility.
 */
export function resumeAfterReplan(
  run: Run,
  options: { updated_at?: string } = {},
): Run {
  if (run.phase === "PlanConsensus") {
    return transitionRunPhase(run, "Implementing", {
      updated_at: options.updated_at ?? new Date().toISOString(),
    });
  }
  if (run.phase === "Planning") {
    // Allow direct path when gates auto-approve
    const via = transitionRunPhase(run, "PlanConsensus", {
      updated_at: options.updated_at ?? new Date().toISOString(),
    });
    return transitionRunPhase(via, "Implementing", {
      updated_at: options.updated_at ?? new Date().toISOString(),
    });
  }
  throw new ReplanError(
    "invalid_phase",
    `resumeAfterReplan requires PlanConsensus or Planning, got ${run.phase}`,
  );
}
