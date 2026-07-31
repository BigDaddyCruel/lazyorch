/**
 * @lazyorch/forge — git + github integration.
 * PR-11: local git worktrees + path-scope locks (no GitHub PR/CI yet).
 * PR-16: feature-branch integrate under global mutex (KD-33/34); no PR/CI yet.
 */

export const PACKAGE_NAME = "@lazyorch/forge" as const;

// --- Path-scope locks (KD-15) ---
export {
  PathScopeLockManager,
  compareLockKeyIds,
  lockKeyId,
  lockKeysConflict,
  looksLikeFilePath,
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
  normalizeRepoRootForHash,
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

// --- Integration mutex + git integrate job (KD-33/34) ---
export {
  IntegrationMutex,
  type MutexAcquireResult,
} from "./integrate-mutex.js";

export {
  integrateTaskBranch,
  createFakeIntegrateGitRunner,
  type IntegrateRequest,
  type IntegrateResult,
  type IntegrateStatus,
} from "./integrate.js";
