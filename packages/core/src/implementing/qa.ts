/**
 * Run-level QA helpers (ephemeral sessions; re-QA at feature tip).
 *
 * Exit predicate requires qa.passed_at_commit == feature_tip_sha.
 * Any successful integrate clears QA (see integrateOne) — must re-run.
 */

import { generateId } from "@lazyorch/shared";
import { evaluatingImplementingExit } from "../orchestrator/exit-predicate.js";
import { OPEN_TASK_STATUSES } from "../orchestrator/task-fsm.js";
import type { Run } from "../types/run.js";
import type { Task } from "../types/task.js";
import type { QaSessionOutcome } from "./ports.js";

export type DynamicFixReason =
  | "qa_fail"
  | "ci_fail"
  | "changes_requested";

/**
 * True when all plan/dynamic tasks are terminal (done|cancelled) but
 * run-level QA does not match the current feature tip.
 */
export function needsRunLevelQa(
  run: Pick<Run, "feature_tip_sha" | "qa">,
  tasks: readonly Task[],
): boolean {
  for (const t of tasks) {
    if (OPEN_TASK_STATUSES.has(t.status)) return false;
    if (t.status !== "done" && t.status !== "cancelled") return false;
  }
  const tip = run.feature_tip_sha;
  if (tip === undefined || tip === "") return false;
  return run.qa?.passed_at_commit !== tip;
}

/**
 * Tasks are done and exit predicate would hold except possibly QA.
 * (Same as needsRunLevelQa when tip present; false if open work remains.)
 */
export function candidatesForRunLevelQa(
  run: Pick<Run, "feature_tip_sha" | "qa">,
  tasks: readonly Task[],
): boolean {
  return needsRunLevelQa(run, tasks);
}

/**
 * Record QA pass at tip (pure).
 */
export function applyQaPass(
  run: Run,
  tip: string,
  now?: () => string,
): Run {
  return {
    ...run,
    feature_tip_sha: tip,
    qa: { passed_at_commit: tip },
    updated_at: now?.() ?? new Date().toISOString(),
  };
}

/**
 * Clear QA state (e.g. tip moved). Pure.
 */
export function invalidateRunQa(run: Run, now?: () => string): Run {
  const next: Run = {
    ...run,
    updated_at: now?.() ?? new Date().toISOString(),
  };
  delete next.qa;
  return next;
}

export interface CreateDynamicFixTasksOpts {
  run_id: string;
  reason: DynamicFixReason;
  summary?: string;
  failed_checks?: readonly string[];
  /** Path scopes for the fix task (default empty → broad). */
  scope?: readonly string[];
  nextTaskId?: () => string;
  max_attempts?: number;
  priority?: Task["priority"];
}

/**
 * Open dynamic fix tasks after QA fail / CI fail / changes requested.
 * Default: one task summarizing the failure.
 */
export function createDynamicFixTasks(
  opts: CreateDynamicFixTasksOpts,
): Task[] {
  const id = opts.nextTaskId?.() ?? generateId("tsk");
  const checkPart =
    opts.failed_checks && opts.failed_checks.length > 0
      ? ` Failed checks: ${opts.failed_checks.join(", ")}.`
      : "";
  const summary = opts.summary ?? opts.reason;
  const title =
    opts.reason === "ci_fail"
      ? `CI fix: ${opts.failed_checks?.[0] ?? "checks"}`
      : opts.reason === "qa_fail"
        ? "QA fix"
        : "Address review changes";

  const task: Task = {
    id,
    run_id: opts.run_id,
    title,
    description: `${summary}${checkPart}`.trim(),
    status: "ready",
    origin: "dynamic",
    priority: opts.priority ?? 1,
    depends_on: [],
    role_affinity: ["worker"],
    scope: opts.scope ? [...opts.scope] : [],
    acceptance: ["fix root cause", "tests pass"],
    review_criteria: ["no regressions"],
    workspace_mode: "worktree",
    attempt: 0,
    max_attempts: opts.max_attempts ?? 3,
    artifacts: [],
  };
  return [task];
}

export interface ApplyQaOutcomeResult {
  run: Run;
  tasks: Task[];
  /** True when QA recorded pass at tip. */
  passed: boolean;
  /** Dynamic tasks opened on failure. */
  fix_tasks: Task[];
}

/**
 * Apply QA session outcome:
 * - passed → qa.passed_at_commit = tip
 * - failed → create dynamic fix tasks; stay Implementing (caller keeps phase)
 */
export function applyQaOutcome(
  run: Run,
  tasks: readonly Task[],
  outcome: QaSessionOutcome,
  opts?: {
    feature_tip_sha?: string;
    now?: () => string;
    nextTaskId?: () => string;
  },
): ApplyQaOutcomeResult {
  const tip =
    opts?.feature_tip_sha ?? run.feature_tip_sha ?? "";
  if (outcome.passed) {
    if (!tip) {
      return {
        run,
        tasks: [...tasks],
        passed: false,
        fix_tasks: [],
      };
    }
    return {
      run: applyQaPass(run, tip, opts?.now),
      tasks: [...tasks],
      passed: true,
      fix_tasks: [],
    };
  }

  // Fail → dynamic fix tasks
  const titles = outcome.fix_titles;
  const fix_tasks: Task[] = [];
  if (titles && titles.length > 0) {
    for (const t of titles) {
      fix_tasks.push(
        ...createDynamicFixTasks({
          run_id: run.id,
          reason: "qa_fail",
          summary: t,
          ...(opts?.nextTaskId !== undefined
            ? { nextTaskId: opts.nextTaskId }
            : {}),
        }),
      );
    }
  } else {
    fix_tasks.push(
      ...createDynamicFixTasks({
        run_id: run.id,
        reason: "qa_fail",
        summary: outcome.summary ?? outcome.error_message ?? "QA failed",
        ...(opts?.nextTaskId !== undefined
          ? { nextTaskId: opts.nextTaskId }
          : {}),
      }),
    );
  }

  return {
    run,
    tasks: [...tasks, ...fix_tasks],
    passed: false,
    fix_tasks,
  };
}

/**
 * Whether Implementing exit predicate holds after current tasks + QA state.
 */
export function canExitAfterQa(
  run: Pick<Run, "feature_tip_sha" | "qa">,
  tasks: readonly Task[],
): boolean {
  return evaluatingImplementingExit(run, tasks).ok;
}
