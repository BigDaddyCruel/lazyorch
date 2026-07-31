/**
 * @lazyorch/forge — git + github integration.
 * PR-11: local git worktrees + path-scope locks (no GitHub PR/CI yet).
 */

export const PACKAGE_NAME = "@lazyorch/forge" as const;

// --- Path-scope locks (KD-15) ---
export {
  PathScopeLockManager,
  compareLockKeyIds,
  lockKeyId,
  lockKeysConflict,
  normalizeScope,
  pathUnderPrefix,
  scopeToLockKey,
  scopesConflict,
  scopesToSortedKeyIds,
  type AcquireResult,
  type HeldLock,
  type LockKey,
  type LockKeyKind,
  type ScopeConflict,
} from "./path-scope-lock.js";

// --- Git runner ---
export {
  GitError,
  gitOk,
  realGitRunner,
  type GitRunOptions,
  type GitRunResult,
  type GitRunner,
} from "./git/runner.js";

// --- Worktrees ---
export {
  createFakeGitRunner,
  createWorktree,
  defaultWorktreeRoot,
  featureBranchName,
  hashRepoRoot,
  isWorktreeClean,
  removeWorktree,
  resolveWorktreePaths,
  taskBranchName,
  type CreateWorktreeOptions,
  type RemoveWorktreeOptions,
  type RemoveWorktreeResult,
  type ResolveWorktreePathOptions,
  type WorktreeOpResult,
  type WorktreePaths,
} from "./git/worktree.js";
