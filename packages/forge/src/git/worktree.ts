/**
 * Git worktree helpers for task isolation.
 *
 * - Windows default worktree root is outside the repo (short path).
 * - No stash-by-default (KD / design: stash-auto is forbidden).
 * - Simple child_process git invocations via injectable GitRunner.
 * - dryRun / fake runner for tests without real git.
 */

import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import {
  gitOk,
  realGitRunner,
  type GitRunResult,
  type GitRunner,
} from "./runner.js";

export interface WorktreePaths {
  /** Absolute path to the worktree directory. */
  worktreePath: string;
  /** Branch name: lazyorch/<run_id>/<task_id> */
  branch: string;
  /** Parent root under which task worktrees live. */
  worktreeRoot: string;
}

export interface ResolveWorktreePathOptions {
  repoRoot: string;
  taskId: string;
  runId: string;
  /**
   * Override worktree root. `null`/`undefined` → platform default.
   * Absolute path or relative to repoRoot.
   */
  worktreeRoot?: string | null;
  /**
   * Short project id for Windows default path segment.
   * Defaults to a hash of the resolved repo root.
   */
  projectHash?: string;
}

export interface CreateWorktreeOptions extends ResolveWorktreePathOptions {
  /**
   * Git ref to base the new branch on (default: HEAD).
   * Typically the run feature branch `lazyorch/<run_id>/feature`.
   */
  baseRef?: string;
  /** If true, only compute paths/commands; do not run git. */
  dryRun?: boolean;
  /** Custom git runner (tests / fake mode). Defaults to real git. */
  git?: GitRunner;
  /**
   * When true, `git worktree add --force` if path exists in worktree list.
   * Default false.
   */
  force?: boolean;
}

export interface RemoveWorktreeOptions {
  repoRoot: string;
  worktreePath: string;
  /** Optional branch to delete after worktree remove (local only). */
  branch?: string;
  /** If true, only report planned commands. */
  dryRun?: boolean;
  git?: GitRunner;
  /**
   * Force-remove worktree even if dirty (`git worktree remove --force`).
   * Default false — dirty trees must be resolved (no stash-auto).
   */
  force?: boolean;
  /** When true and branch set, delete branch with `git branch -d` (or -D if forceBranch). */
  deleteBranch?: boolean;
  forceBranch?: boolean;
}

export interface WorktreeOpResult extends WorktreePaths {
  /** Commands that were (or would be) run. */
  commands: string[][];
  dryRun: boolean;
}

export interface RemoveWorktreeResult {
  worktreePath: string;
  commands: string[][];
  dryRun: boolean;
}

/** Feature branch for a run: `lazyorch/<run_id>/feature`. */
export function featureBranchName(runId: string): string {
  assertSafeId(runId, "runId");
  return `lazyorch/${runId}/feature`;
}

/** Task branch: `lazyorch/<run_id>/<task_id>`. */
export function taskBranchName(runId: string, taskId: string): string {
  assertSafeId(runId, "runId");
  assertSafeId(taskId, "taskId");
  return `lazyorch/${runId}/${taskId}`;
}

/**
 * Short stable hash of an absolute repo root (for Windows worktree path segment).
 */
export function hashRepoRoot(repoRoot: string): string {
  const abs = resolve(repoRoot);
  return createHash("sha256").update(abs).digest("hex").slice(0, 12);
}

/**
 * Default worktree root:
 * - Windows: `%USERPROFILE%\.lazyorch\worktrees\<project_hash>`
 * - else: `<repo>/.lazyorch/worktrees`
 */
export function defaultWorktreeRoot(
  repoRoot: string,
  projectHash?: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const absRepo = resolve(repoRoot);
  if (platform === "win32") {
    const home =
      process.env.USERPROFILE ?? process.env.HOME ?? process.env.HOMEPATH;
    if (!home) {
      // Fallback inside repo if home is missing
      return join(absRepo, ".lazyorch", "worktrees");
    }
    const hash = projectHash ?? hashRepoRoot(absRepo);
    return join(home, ".lazyorch", "worktrees", hash);
  }
  return join(absRepo, ".lazyorch", "worktrees");
}

/**
 * Resolve absolute worktree path + branch for a task.
 * Rejects path traversal in taskId / unsafe segments.
 */
export function resolveWorktreePaths(
  opts: ResolveWorktreePathOptions,
  platform: NodeJS.Platform = process.platform,
): WorktreePaths {
  const repoRoot = resolve(opts.repoRoot);
  assertSafeId(opts.taskId, "taskId");
  assertSafeId(opts.runId, "runId");

  let root: string;
  if (opts.worktreeRoot != null && opts.worktreeRoot !== "") {
    root = isAbsolute(opts.worktreeRoot)
      ? normalize(opts.worktreeRoot)
      : resolve(repoRoot, opts.worktreeRoot);
  } else {
    root = defaultWorktreeRoot(repoRoot, opts.projectHash, platform);
  }

  const worktreePath = resolve(join(root, opts.taskId));
  // Ensure worktreePath is under root (no .. escape via taskId — already asserted)
  const rootNorm = withTrailingSep(resolve(root));
  if (
    worktreePath !== resolve(root) &&
    !worktreePath.startsWith(rootNorm) &&
    // Windows path prefix compare is case-insensitive
    !worktreePath.toLowerCase().startsWith(rootNorm.toLowerCase())
  ) {
    throw new Error(
      `Worktree path escapes worktree root: ${worktreePath} not under ${root}`,
    );
  }

  return {
    worktreePath,
    worktreeRoot: resolve(root),
    branch: taskBranchName(opts.runId, opts.taskId),
  };
}

function withTrailingSep(p: string): string {
  return p.endsWith(sep) ? p : p + sep;
}

/**
 * Create a git worktree + branch for a task.
 * Never stashes. Uses `git worktree add -b <branch> <path> <baseRef>`.
 */
export async function createWorktree(
  opts: CreateWorktreeOptions,
): Promise<WorktreeOpResult> {
  const paths = resolveWorktreePaths(opts);
  const baseRef = opts.baseRef ?? "HEAD";
  const dryRun = opts.dryRun === true;
  const git = opts.git ?? realGitRunner;
  const commands: string[][] = [];

  const addArgs = ["worktree", "add"];
  if (opts.force) addArgs.push("--force");
  addArgs.push("-b", paths.branch, paths.worktreePath, baseRef);
  commands.push(addArgs);

  if (!dryRun) {
    await mkdir(paths.worktreeRoot, { recursive: true });
    await gitOk(git, addArgs, { cwd: resolve(opts.repoRoot) });
  }

  return { ...paths, commands, dryRun };
}

/**
 * Remove a worktree. Does **not** stash dirty changes.
 * Without `force`, git refuses dirty worktrees — caller must resolve or force.
 */
export async function removeWorktree(
  opts: RemoveWorktreeOptions,
): Promise<RemoveWorktreeResult> {
  const worktreePath = resolve(opts.worktreePath);
  const dryRun = opts.dryRun === true;
  const git = opts.git ?? realGitRunner;
  const commands: string[][] = [];
  const repoRoot = resolve(opts.repoRoot);

  const removeArgs = ["worktree", "remove"];
  if (opts.force) removeArgs.push("--force");
  removeArgs.push(worktreePath);
  commands.push(removeArgs);

  if (!dryRun) {
    await gitOk(git, removeArgs, { cwd: repoRoot });
  }

  if (opts.deleteBranch && opts.branch) {
    const branchArgs = [
      "branch",
      opts.forceBranch || opts.force ? "-D" : "-d",
      opts.branch,
    ];
    commands.push(branchArgs);
    if (!dryRun) {
      await gitOk(git, branchArgs, { cwd: repoRoot });
    }
  }

  return { worktreePath, commands, dryRun };
}

/**
 * True if `git status --porcelain` is empty in the worktree.
 * Does not stash. Unmerged paths imply dirty.
 */
export async function isWorktreeClean(
  worktreePath: string,
  git: GitRunner = realGitRunner,
): Promise<boolean> {
  const result = await gitOk(git, ["status", "--porcelain"], {
    cwd: resolve(worktreePath),
  });
  return result.stdout.trim() === "";
}

/** Ids used in branch/path segments: no slashes, `..`, or control chars. */
function assertSafeId(id: string, label: string): void {
  if (id === "" || id === "." || id === "..") {
    throw new Error(`Invalid ${label}: empty or dot segment`);
  }
  if (
    id.includes("/") ||
    id.includes("\\") ||
    id.includes("..") ||
    id.includes("\0")
  ) {
    throw new Error(
      `Invalid ${label}: must not contain path separators or '..' (${id})`,
    );
  }
}

/**
 * In-memory fake git runner for unit tests (no real git required).
 * Records calls; simulates successful worktree add/remove/status.
 */
export function createFakeGitRunner(options?: {
  /** Porcelain status output for `status --porcelain` (default clean). */
  statusPorcelain?: string;
  /** Fail matching command prefixes with this exit code. */
  failArgsPrefix?: string[];
  failCode?: number;
}): GitRunner & { calls: { args: string[]; cwd?: string }[] } {
  const calls: { args: string[]; cwd?: string }[] = [];
  const runner: GitRunner & { calls: typeof calls } = async (
    args,
    runOpts,
  ): Promise<GitRunResult> => {
    calls.push({
      args: [...args],
      ...(runOpts?.cwd !== undefined ? { cwd: runOpts.cwd } : {}),
    });
    if (options?.failArgsPrefix) {
      const pref = options.failArgsPrefix;
      if (pref.every((p, i) => args[i] === p)) {
        return {
          stdout: "",
          stderr: `fake fail: ${args.join(" ")}`,
          code: options.failCode ?? 1,
        };
      }
    }
    if (args[0] === "status" && args.includes("--porcelain")) {
      return {
        stdout: options?.statusPorcelain ?? "",
        stderr: "",
        code: 0,
      };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  runner.calls = calls;
  return runner;
}
