/**
 * Pure task FSM appliers for worker / review / integrate outcomes.
 */

import { transitionTaskStatus } from "../orchestrator/task-fsm.js";
import type { Task } from "../types/task.js";
import type {
  ForgeIntegrateResult,
  ReviewerSessionOutcome,
  WorkerSessionOutcome,
} from "./ports.js";

export class ImplementingError extends Error {
  readonly code:
    | "invalid_status"
    | "max_attempts"
    | "mutex_held"
    | "invalid_phase";

  constructor(code: ImplementingError["code"], message: string) {
    super(message);
    this.name = "ImplementingError";
    this.code = code;
  }
}

/**
 * Apply worker session outcome to an in_progress task.
 *
 * - submit_for_review → review (or integrating after conflict-only rework)
 * - fail / error / timeout / stall → ready (requeue, attempt++) or failed
 * - requeue → ready with attempt++
 */
export function applyWorkerOutcome(
  task: Task,
  outcome: WorkerSessionOutcome,
): Task {
  if (task.status !== "in_progress") {
    throw new ImplementingError(
      "invalid_status",
      `applyWorkerOutcome requires in_progress, got ${task.status}`,
    );
  }

  if (outcome.kind === "submit_for_review") {
    const artifacts =
      outcome.artifacts !== undefined
        ? [...task.artifacts, ...outcome.artifacts]
        : task.artifacts;

    // Marker-only conflict rework (KD-34): skip full code review via
    // in_progress → review → integrating (no direct in_progress→integrating edge).
    if (outcome.material_product_change === false) {
      const reviewed = transitionTaskStatus(task, "review", {
        clear_blocked: true,
        needs_re_review: false,
      });
      const next = transitionTaskStatus(reviewed, "integrating", {
        clear_integrate_error: true,
        needs_re_review: false,
      });
      return { ...next, artifacts };
    }

    const next = transitionTaskStatus(task, "review", {
      clear_blocked: true,
      needs_re_review:
        outcome.material_product_change === true ? true : false,
    });
    return { ...next, artifacts };
  }

  // Failure-like outcomes: requeue or terminal fail
  const canRetry = task.attempt < task.max_attempts;
  if (
    outcome.kind === "fail" ||
    outcome.kind === "error" ||
    outcome.kind === "timeout" ||
    outcome.kind === "stall" ||
    outcome.kind === "requeue"
  ) {
    if (canRetry && outcome.kind !== "fail") {
      // Soft failures requeue with attempt++
      return transitionTaskStatus(task, "ready", {
        increment_attempt: true,
      });
    }
    if (canRetry && outcome.kind === "fail") {
      // Quality fail: requeue when under max (attempt++ on failed→ready path
      // goes via failed first only at exhaustion; design: attempt++ then requeue)
      const failed = transitionTaskStatus(task, "failed");
      if (failed.attempt < failed.max_attempts) {
        return transitionTaskStatus(failed, "ready");
      }
      return failed;
    }
    // Exhausted
    return transitionTaskStatus(task, "failed");
  }

  throw new ImplementingError(
    "invalid_status",
    `Unknown worker outcome kind: ${(outcome as WorkerSessionOutcome).kind}`,
  );
}

/**
 * Apply reviewer decision to a review task.
 * - approve → integrating
 * - reject → ready (attempt++ for escalate on next assign)
 * - invalid → stays review (caller may count consecutive invalids)
 */
export function applyReviewDecision(
  task: Task,
  outcome: ReviewerSessionOutcome,
): Task {
  if (task.status !== "review") {
    throw new ImplementingError(
      "invalid_status",
      `applyReviewDecision requires review, got ${task.status}`,
    );
  }

  if (outcome.decision === "approve") {
    return transitionTaskStatus(task, "integrating", {
      clear_blocked: true,
      needs_re_review: false,
    });
  }

  if (outcome.decision === "reject") {
    const canRetry = task.attempt < task.max_attempts;
    if (!canRetry) {
      return transitionTaskStatus(task, "failed");
    }
    // Reject for quality: requeue ready with attempt++ so router escalates
    return transitionTaskStatus(task, "ready", {
      increment_attempt: true,
    });
  }

  // invalid — leave in review for requeue of reviewer session
  return task;
}

export interface ApplyIntegrateOptions {
  /** When true (default), path locks are NOT released on conflict (KD-34). */
  retain_locks_on_conflict?: boolean;
}

export interface ApplyIntegrateResult {
  task: Task;
  /** New feature tip when integrate succeeded. */
  feature_tip_sha?: string;
  /** True when path-scope locks should be released (done / cancelled / abandon). */
  release_scope_locks: boolean;
  /** True when mutex must be released (always after integrate attempt). */
  release_mutex: boolean;
}

/**
 * Apply forge integrate result to an integrating task (KD-33/34).
 *
 * - ok → done; release path locks; release mutex; clear QA tip invalidation is caller's job
 * - conflict → blocked/integrate_conflict; keep path locks; release mutex
 * - error → failed (or blocked resource); release mutex; release locks on failed
 */
export function applyIntegrateResult(
  task: Task,
  result: ForgeIntegrateResult,
  _options: ApplyIntegrateOptions = {},
): ApplyIntegrateResult {
  if (task.status !== "integrating") {
    throw new ImplementingError(
      "invalid_status",
      `applyIntegrateResult requires integrating, got ${task.status}`,
    );
  }

  if (result.status === "ok") {
    const next = transitionTaskStatus(task, "done", {
      clear_blocked: true,
      clear_integrate_error: true,
    });
    return {
      task: next,
      ...(result.feature_tip_sha !== undefined
        ? { feature_tip_sha: result.feature_tip_sha }
        : {}),
      release_scope_locks: true,
      release_mutex: true,
    };
  }

  if (result.status === "conflict" || result.conflict === true) {
    const next = transitionTaskStatus(task, "blocked", {
      blocked_reason: "integrate_conflict",
      integrate_error: result.error_message ?? "merge conflict",
    });
    return {
      task: next,
      release_scope_locks: false, // KD-34: keep scope locks
      release_mutex: true,
    };
  }

  // Hard integrate error
  const next = transitionTaskStatus(task, "failed", {
    integrate_error: result.error_message ?? "integrate error",
  });
  // Store error on failed task via extend
  const withErr: Task = {
    ...next,
    integrate_error: result.error_message ?? "integrate error",
  };
  return {
    task: withErr,
    release_scope_locks: true,
    release_mutex: true,
  };
}

/**
 * KD-34 recovery: blocked/integrate_conflict → ready for same-task rework.
 * Path locks stay held by this task id (caller does not release).
 * Increments attempt so escalate + max_attempts apply.
 */
export function recoverIntegrateConflict(task: Task): Task {
  if (
    task.status !== "blocked" ||
    task.blocked_reason !== "integrate_conflict"
  ) {
    throw new ImplementingError(
      "invalid_status",
      `recoverIntegrateConflict requires blocked/integrate_conflict, got ${task.status}/${task.blocked_reason}`,
    );
  }

  // Keep integrate_error for worker instructions; clear blocked_reason on ready
  return transitionTaskStatus(task, "ready", {
    increment_attempt: true,
    clear_blocked: true,
  });
}

/**
 * After conflict rework, if only markers fixed → integrating; else review.
 */
export function afterConflictRework(
  task: Task,
  materialProductChange: boolean,
): Task {
  if (task.status !== "in_progress") {
    throw new ImplementingError(
      "invalid_status",
      `afterConflictRework requires in_progress, got ${task.status}`,
    );
  }
  if (materialProductChange) {
    return transitionTaskStatus(task, "review", {
      needs_re_review: true,
      clear_integrate_error: true,
    });
  }
  // Markers only: review→integrating without waiting on reviewer session
  const reviewed = transitionTaskStatus(task, "review", {
    needs_re_review: false,
  });
  return transitionTaskStatus(reviewed, "integrating", {
    needs_re_review: false,
    clear_integrate_error: true,
  });
}
