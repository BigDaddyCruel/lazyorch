import type { Run } from "../types/run.js";
import type { Task, TaskStatus } from "../types/task.js";
import { OPEN_TASK_STATUSES } from "./task-fsm.js";

export interface ExitPredicateParams {
  /**
   * Feature tip SHA to require QA against. Defaults to `run.feature_tip_sha`.
   * When both are undefined, QA tip match fails (cannot exit).
   */
  feature_tip_sha?: string;
  /**
   * Commit at which QA last passed. Defaults to `run.qa?.passed_at_commit`.
   */
  qa_passed_at_commit?: string | undefined;
  /**
   * When true, skip QA tip equality check (tests / forced exit). Default false.
   */
  skip_qa_check?: boolean;
}

export interface ExitPredicateResult {
  ok: boolean;
  /** Human-readable reasons when not ok */
  reasons: string[];
  open_task_ids: string[];
  qa_matches: boolean;
}

const TERMINAL_OK: ReadonlySet<TaskStatus> = new Set(["done", "cancelled"]);

/**
 * Normative Implementing → next phase exit predicate.
 *
 * All must hold:
 * 1. Every non-cancelled plan+dynamic task is `done` (cancelled waived).
 * 2. No task in open statuses (todo|ready|in_progress|review|blocked|integrating|failed).
 * 3. Approved work is integrated (`done` implies integrate succeeded).
 * 4. Run-level QA passed against current feature tip
 *    (`qa.passed_at_commit == feature_tip_sha`), unless skip_qa_check.
 */
export function evaluatingImplementingExit(
  run: Pick<Run, "feature_tip_sha" | "qa">,
  tasks: readonly Task[],
  params: ExitPredicateParams = {},
): ExitPredicateResult {
  const reasons: string[] = [];
  const open_task_ids: string[] = [];

  for (const t of tasks) {
    if (OPEN_TASK_STATUSES.has(t.status)) {
      open_task_ids.push(t.id);
    } else if (!TERMINAL_OK.has(t.status)) {
      // defensive: unknown non-terminal
      open_task_ids.push(t.id);
    }
  }

  if (open_task_ids.length > 0) {
    reasons.push(
      `open tasks: ${open_task_ids.join(", ")} (statuses not all done|cancelled)`,
    );
  }

  // Non-cancelled must be done — equivalent to: every task is done or cancelled
  const incomplete = tasks.filter((t) => t.status !== "done" && t.status !== "cancelled");
  if (incomplete.length > 0 && open_task_ids.length === 0) {
    // should not happen if OPEN covers all non-terminals
    for (const t of incomplete) open_task_ids.push(t.id);
    reasons.push(
      `incomplete non-cancelled tasks: ${incomplete.map((t) => t.id).join(", ")}`,
    );
  }

  const tip =
    params.feature_tip_sha !== undefined
      ? params.feature_tip_sha
      : run.feature_tip_sha;
  const qaCommit =
    params.qa_passed_at_commit !== undefined
      ? params.qa_passed_at_commit
      : run.qa?.passed_at_commit;

  let qa_matches = false;
  if (params.skip_qa_check) {
    qa_matches = true;
  } else if (tip === undefined || tip === "") {
    reasons.push("feature_tip_sha is missing; cannot match QA");
    qa_matches = false;
  } else if (qaCommit === undefined || qaCommit === "") {
    reasons.push("qa.passed_at_commit is missing");
    qa_matches = false;
  } else if (qaCommit !== tip) {
    reasons.push(
      `qa.passed_at_commit (${qaCommit}) != feature_tip_sha (${tip})`,
    );
    qa_matches = false;
  } else {
    qa_matches = true;
  }

  const ok = open_task_ids.length === 0 && qa_matches;
  return { ok, reasons, open_task_ids, qa_matches };
}

/** Convenience boolean form of {@link evaluatingImplementingExit}. */
export function canExitImplementing(
  run: Pick<Run, "feature_tip_sha" | "qa">,
  tasks: readonly Task[],
  params: ExitPredicateParams = {},
): boolean {
  return evaluatingImplementingExit(run, tasks, params).ok;
}
