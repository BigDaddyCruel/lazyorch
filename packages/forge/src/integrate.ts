/**
 * Feature-branch integrate git job (KD-33).
 *
 * Merges a task branch into the run feature tip under the caller's mutex.
 * No LLM / agent slot. Injectable GitRunner for tests (no real git required).
 *
 * Conflict path (KD-34): abort merge, return conflict; caller releases mutex
 * and moves task → blocked / integrate_conflict while keeping path-scope locks.
 */

import {
  GitError,
  gitOk,
  realGitRunner,
  type GitRunner,
} from "./git/runner.js";
import { featureBranchName, taskBranchName } from "./git/worktree.js";

export type IntegrateStatus = "ok" | "conflict" | "error";

export interface IntegrateRequest {
  repoRoot: string;
  runId: string;
  taskId: string;
  /** Override feature branch name (default lazyorch/<runId>/feature). */
  featureBranch?: string;
  /** Override task branch name (default lazyorch/<runId>/<taskId>). */
  taskBranch?: string;
  /**
   * Working tree for merge (default: repoRoot).
   * Daemon may check out feature in a dedicated worktree.
   */
  cwd?: string;
  git?: GitRunner;
  /** If true, only compute planned steps; do not run git. */
  dryRun?: boolean;
}

export interface IntegrateResult {
  status: IntegrateStatus;
  feature_branch: string;
  task_branch: string;
  /** New feature tip after successful merge. */
  feature_tip_sha?: string;
  error_message?: string;
  /** True when git reported merge conflict. */
  conflict?: boolean;
  commands: string[][];
  dryRun: boolean;
}

function isMergeConflict(err: unknown): boolean {
  if (!(err instanceof GitError)) return false;
  const text = `${err.stderr}\n${err.stdout}`.toLowerCase();
  return (
    err.code !== 0 &&
    (text.includes("conflict") ||
      text.includes("automatic merge failed") ||
      text.includes("fix conflicts") ||
      text.includes("unmerged paths"))
  );
}

/**
 * Merge task branch into feature branch (git merge --no-ff by default).
 * On conflict: aborts the merge and returns status "conflict".
 */
export async function integrateTaskBranch(
  req: IntegrateRequest,
): Promise<IntegrateResult> {
  const feature =
    req.featureBranch ?? featureBranchName(req.runId);
  const taskBr = req.taskBranch ?? taskBranchName(req.runId, req.taskId);
  const cwd = req.cwd ?? req.repoRoot;
  const git = req.git ?? realGitRunner;
  const dryRun = req.dryRun ?? false;

  const commands: string[][] = [
    ["checkout", feature],
    ["merge", "--no-ff", "-m", `integrate ${req.taskId}`, taskBr],
    ["rev-parse", "HEAD"],
  ];

  if (dryRun) {
    return {
      status: "ok",
      feature_branch: feature,
      task_branch: taskBr,
      feature_tip_sha: "dry-run-tip",
      commands,
      dryRun: true,
    };
  }

  try {
    await gitOk(git, ["checkout", feature], { cwd });
  } catch (err) {
    return {
      status: "error",
      feature_branch: feature,
      task_branch: taskBr,
      error_message:
        err instanceof Error ? err.message : `checkout ${feature} failed`,
      commands,
      dryRun: false,
    };
  }

  try {
    await gitOk(
      git,
      ["merge", "--no-ff", "-m", `integrate ${req.taskId}`, taskBr],
      { cwd },
    );
  } catch (err) {
    // Abort in-flight merge on conflict (or any merge failure)
    try {
      await git(["merge", "--abort"], { cwd });
    } catch {
      // best-effort abort
    }
    if (isMergeConflict(err)) {
      return {
        status: "conflict",
        feature_branch: feature,
        task_branch: taskBr,
        conflict: true,
        error_message:
          err instanceof Error ? err.message : "merge conflict",
        commands: [...commands, ["merge", "--abort"]],
        dryRun: false,
      };
    }
    return {
      status: "error",
      feature_branch: feature,
      task_branch: taskBr,
      error_message: err instanceof Error ? err.message : "merge failed",
      commands: [...commands, ["merge", "--abort"]],
      dryRun: false,
    };
  }

  try {
    const rev = await gitOk(git, ["rev-parse", "HEAD"], { cwd });
    const tip = rev.stdout.trim();
    return {
      status: "ok",
      feature_branch: feature,
      task_branch: taskBr,
      feature_tip_sha: tip,
      commands,
      dryRun: false,
    };
  } catch (err) {
    return {
      status: "error",
      feature_branch: feature,
      task_branch: taskBr,
      error_message:
        err instanceof Error ? err.message : "rev-parse HEAD failed",
      commands,
      dryRun: false,
    };
  }
}

/**
 * Fake GitRunner scripted for integrate tests.
 * `mergeOutcomes` queue: "ok" | "conflict" | "error" per merge call.
 */
export function createFakeIntegrateGitRunner(options?: {
  tipSha?: string;
  mergeOutcomes?: Array<"ok" | "conflict" | "error">;
}): GitRunner {
  const tip = options?.tipSha ?? "abc123featuretip00000000000000000001";
  const outcomes = [...(options?.mergeOutcomes ?? ["ok"])];

  return async (args) => {
    const cmd = args[0];
    if (cmd === "checkout") {
      return { stdout: "", stderr: "", code: 0 };
    }
    if (cmd === "merge") {
      if (args[1] === "--abort") {
        return { stdout: "", stderr: "", code: 0 };
      }
      const outcome = outcomes.shift() ?? "ok";
      if (outcome === "ok") {
        return { stdout: "Merge made by the 'ort' strategy.\n", stderr: "", code: 0 };
      }
      if (outcome === "conflict") {
        return {
          stdout: "Automatic merge failed; fix conflicts and then commit the result.\n",
          stderr: "CONFLICT (content): Merge conflict in src/a.ts\n",
          code: 1,
        };
      }
      return {
        stdout: "",
        stderr: "fatal: refusing to merge unrelated histories\n",
        code: 128,
      };
    }
    if (cmd === "rev-parse") {
      return { stdout: `${tip}\n`, stderr: "", code: 0 };
    }
    return { stdout: "", stderr: `unexpected git ${args.join(" ")}`, code: 1 };
  };
}
