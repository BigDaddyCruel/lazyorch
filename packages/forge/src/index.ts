/**
 * @lazyorch/forge — git + github integration.
 * PR-11: local git worktrees + path-scope locks.
 * PR-16: feature-branch integrate under global mutex (KD-33/34).
 * PR-17: GitHub ensure_ready_pr, check poll, merge helpers + FakeGithubClient.
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

// --- GitHub PR / CI / merge (PR-17) ---
export {
  FakeGithubClient,
  EnsureReadyPrError,
  ensureDraftPr,
  ensureReadyPr,
  evaluateChecks,
  isCheckFailed,
  isCheckOk,
  isCheckPending,
  pollCheckStatus,
  MergePrError,
  mergeReadyPr,
  type CheckConclusion,
  type CheckRun,
  type CheckRunStatus,
  type CreatePrInput,
  type EnsureReadyPrAction,
  type EnsureReadyPrRequest,
  type EnsureReadyPrResult,
  type FakeGithubCall,
  type FakeGithubClientOptions,
  type GithubClient,
  type GithubPr,
  type GithubPrState,
  type MergeMethod,
  type MergePrInput,
  type MergePrResult,
  type MergeReadyPrRequest,
  type PollChecksRequest,
  type PollChecksResult,
} from "./github/index.js";
