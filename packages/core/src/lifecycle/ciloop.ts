/**
 * CILoop phase: poll required checks → MergeReady or re-enter Implementing.
 */

import { generateId } from "@lazyorch/shared";
import { transitionRunPhase } from "../orchestrator/run-fsm.js";
import { createDynamicFixTasks } from "../implementing/qa.js";
import type { Run } from "../types/run.js";
import type { Task } from "../types/task.js";
import type { ForgeGithubPort, PollChecksPortResult } from "./ports.js";

export interface CiLoopConfig {
  required_checks?: readonly string[];
  owner?: string;
  repo?: string;
}

export interface RunCiLoopResult {
  run: Run;
  tasks: Task[];
  poll?: PollChecksPortResult;
  /** Dynamic CI fix tasks opened this tick. */
  fix_tasks: Task[];
  transitions: Array<{ from: string; to: string }>;
}

/**
 * One CILoop poll tick.
 *
 * - pending → stay CILoop
 * - required_green → MergeReady
 * - required_failed → open dynamic fix tasks → Implementing
 */
export async function runCiLoopTick(
  run: Run,
  tasks: readonly Task[],
  forge: ForgeGithubPort,
  config: CiLoopConfig = {},
  opts?: {
    now?: () => string;
    nextTaskId?: () => string;
  },
): Promise<RunCiLoopResult> {
  if (run.phase !== "CILoop") {
    throw new Error(`runCiLoopTick requires CILoop, got ${run.phase}`);
  }

  const ts = opts?.now?.() ?? new Date().toISOString();
  const ref =
    run.pr_ref?.head_sha ??
    run.feature_tip_sha ??
    run.feature_branch ??
    "";
  if (!ref) {
    throw new Error("runCiLoopTick: no ref to poll (head_sha / tip / branch)");
  }

  const poll = await forge.pollChecks({
    run_id: run.id,
    ref,
    ...(run.pr_ref?.number !== undefined
      ? { pr_number: run.pr_ref.number }
      : {}),
    required_checks: config.required_checks ?? [],
    ...(config.owner !== undefined ? { owner: config.owner } : {}),
    ...(config.repo !== undefined ? { repo: config.repo } : {}),
  });

  // Optionally refresh head_sha on pr_ref
  let nextRun = run;
  if (poll.head_sha && run.pr_ref) {
    nextRun = {
      ...run,
      pr_ref: { ...run.pr_ref, head_sha: poll.head_sha },
      updated_at: ts,
    };
  }

  if (poll.required_green) {
    nextRun = transitionRunPhase(nextRun, "MergeReady", { updated_at: ts });
    return {
      run: nextRun,
      tasks: [...tasks],
      poll,
      fix_tasks: [],
      transitions: [{ from: "CILoop", to: "MergeReady" }],
    };
  }

  if (poll.required_failed) {
    const fix_tasks = createDynamicFixTasks({
      run_id: run.id,
      reason: "ci_fail",
      summary: `CI failed: ${poll.failed_checks.join(", ") || "required checks"}`,
      failed_checks: poll.failed_checks,
      ...(opts?.nextTaskId !== undefined
        ? { nextTaskId: opts.nextTaskId }
        : {
            nextTaskId: () => generateId("tsk"),
          }),
    });
    nextRun = transitionRunPhase(nextRun, "Implementing", { updated_at: ts });
    // Invalidate QA so re-exit requires re-QA at new tip after fixes
    nextRun = { ...nextRun, qa: {} };
    return {
      run: nextRun,
      tasks: [...tasks, ...fix_tasks],
      poll,
      fix_tasks,
      transitions: [{ from: "CILoop", to: "Implementing" }],
    };
  }

  // pending
  return {
    run: nextRun,
    tasks: [...tasks],
    poll,
    fix_tasks: [],
    transitions: [],
  };
}
