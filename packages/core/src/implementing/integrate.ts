/**
 * Integrate under global mutex (KD-33/34).
 *
 * Executor is forge git only — no lead agent session, no agent slot.
 * Serializes integrating tasks per run (priority then id).
 */

import { releaseTaskScopeLocks } from "../scheduler/assign.js";
import type { ScopeLockPort } from "../scheduler/types.js";
import type { Run } from "../types/run.js";
import type { Task } from "../types/task.js";
import {
  applyIntegrateResult,
  ImplementingError,
} from "./outcomes.js";
import type {
  ForgeIntegratePort,
  ForgeIntegrateResult,
  IntegrationMutexPort,
} from "./ports.js";

export interface IntegrateOneParams {
  run: Run;
  task: Task;
  forge: ForgeIntegratePort;
  mutex: IntegrationMutexPort;
  locks?: ScopeLockPort;
  /** Optional repo root / feature branch overrides for forge. */
  repo_root?: string;
  feature_branch?: string;
}

export interface IntegrateOneResult {
  task: Task;
  run: Run;
  integrate: ForgeIntegrateResult;
  mutex_released: boolean;
  scope_locks_released: boolean;
  /** True when another task holds the mutex — no integrate attempted. */
  deferred: boolean;
  deferred_holder?: string;
}

/**
 * Attempt one integrate for a task already in `integrating`.
 * Acquires mutex → forge.integrate → apply result → always release mutex
 * (in `finally`, so unexpected throws cannot stick the mutex).
 */
export async function integrateOne(
  params: IntegrateOneParams,
): Promise<IntegrateOneResult> {
  const { run, task, forge, mutex } = params;

  if (task.status !== "integrating") {
    throw new ImplementingError(
      "invalid_status",
      `integrateOne requires integrating, got ${task.status}`,
    );
  }

  const acq = mutex.tryAcquire(run.id, task.id);
  if (!acq.ok) {
    return {
      task,
      run,
      integrate: { status: "error", error_message: "mutex_held" },
      mutex_released: false,
      scope_locks_released: false,
      deferred: true,
      deferred_holder: acq.holder,
    };
  }

  let integrate: ForgeIntegrateResult = {
    status: "error",
    error_message: "integrate not started",
  };
  let appliedTask = task;
  let featureTip: string | undefined;
  let releaseLocks = false;
  let mutex_released = false;

  try {
    try {
      integrate = await forge.integrate({
        run_id: run.id,
        task_id: task.id,
        ...(task.branch !== undefined ? { task_branch: task.branch } : {}),
        ...(params.feature_branch !== undefined
          ? { feature_branch: params.feature_branch }
          : run.feature_branch !== undefined
            ? { feature_branch: run.feature_branch }
            : {}),
        ...(task.worktree_path !== undefined
          ? { worktree_path: task.worktree_path }
          : {}),
        ...(params.repo_root !== undefined
          ? { repo_root: params.repo_root }
          : {}),
      });
    } catch (err) {
      integrate = {
        status: "error",
        error_message: err instanceof Error ? err.message : String(err),
      };
    }

    const applied = applyIntegrateResult(task, integrate);
    appliedTask = applied.task;
    featureTip = applied.feature_tip_sha;
    releaseLocks = applied.release_scope_locks;
  } finally {
    mutex.release(run.id);
    mutex_released = true;
  }

  let scope_locks_released = false;
  if (releaseLocks && params.locks) {
    releaseTaskScopeLocks(params.locks, task.id);
    scope_locks_released = true;
  }

  let nextRun = run;
  if (featureTip !== undefined) {
    // Tip moved → invalidate run-level QA (must re-run at new tip)
    nextRun = {
      ...run,
      feature_tip_sha: featureTip,
      updated_at: new Date().toISOString(),
      qa: {},
    };
  }

  return {
    task: appliedTask,
    run: nextRun,
    integrate,
    mutex_released,
    scope_locks_released,
    deferred: false,
  };
}

/**
 * Sort integrating tasks for serial integrate: priority asc, then id.
 */
export function sortIntegratingQueue(tasks: readonly Task[]): Task[] {
  return tasks
    .filter((t) => t.status === "integrating")
    .slice()
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

/**
 * Drain integrating queue serially under the run mutex (one at a time).
 * Stops when mutex is contended externally or queue empty.
 */
export async function drainIntegrateQueue(params: {
  run: Run;
  tasks: readonly Task[];
  forge: ForgeIntegratePort;
  mutex: IntegrationMutexPort;
  locks?: ScopeLockPort;
  repo_root?: string;
  feature_branch?: string;
  /** Max integrates this call (default: all queued). */
  max?: number;
}): Promise<{
  run: Run;
  tasks: Task[];
  results: IntegrateOneResult[];
}> {
  const byId = new Map(params.tasks.map((t) => [t.id, t]));
  let run = params.run;
  const results: IntegrateOneResult[] = [];
  const max = params.max ?? Number.POSITIVE_INFINITY;
  let n = 0;

  // Recompute queue each iteration (status may change)
  while (n < max) {
    const queue = sortIntegratingQueue([...byId.values()]);
    if (queue.length === 0) break;
    const next = queue[0]!;
    const one = await integrateOne({
      run,
      task: next,
      forge: params.forge,
      mutex: params.mutex,
      ...(params.locks !== undefined ? { locks: params.locks } : {}),
      ...(params.repo_root !== undefined
        ? { repo_root: params.repo_root }
        : {}),
      ...(params.feature_branch !== undefined
        ? { feature_branch: params.feature_branch }
        : {}),
    });
    results.push(one);
    byId.set(one.task.id, one.task);
    run = one.run;
    n += 1;
    if (one.deferred) break; // external holder — stop
  }

  return {
    run,
    tasks: params.tasks.map((t) => byId.get(t.id) ?? t),
    results,
  };
}
