/**
 * forge/github — PR ensure, CI checks poll, merge (PR-17 MVP).
 * Agent sessions never hold GH tokens; only forge process uses this client.
 */

export type {
  CheckConclusion,
  CheckRun,
  CheckRunStatus,
  CreatePrInput,
  EnsureReadyPrAction,
  EnsureReadyPrRequest,
  EnsureReadyPrResult,
  GithubClient,
  GithubPr,
  GithubPrState,
  MergeMethod,
  MergePrInput,
  MergePrResult,
  PollChecksRequest,
  PollChecksResult,
} from "./types.js";

export {
  FakeGithubClient,
  type FakeGithubCall,
  type FakeGithubClientOptions,
} from "./fake.js";

export {
  EnsureReadyPrError,
  ensureDraftPr,
  ensureReadyPr,
} from "./ensure-ready-pr.js";

export {
  evaluateChecks,
  isCheckFailed,
  isCheckOk,
  isCheckPending,
  pollCheckStatus,
} from "./checks.js";

export {
  MergePrError,
  mergeReadyPr,
  type MergeReadyPrRequest,
} from "./merge.js";
