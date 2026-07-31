/**
 * GitHub forge types (PR-17).
 * Provider-facing shapes used by GitHubClient and ensure_ready_pr / checks / merge.
 */

export type GithubPrState = "draft" | "ready" | "merged" | "closed";

export type MergeMethod = "squash" | "merge" | "rebase";

export interface GithubPr {
  number: number;
  url: string;
  state: GithubPrState;
  head_sha?: string;
  head_branch: string;
  base_branch: string;
  title: string;
  body?: string;
}

export type CheckRunStatus = "queued" | "in_progress" | "completed";

export type CheckConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "skipped"
  | "timed_out"
  | "action_required"
  | null;

export interface CheckRun {
  name: string;
  status: CheckRunStatus;
  conclusion?: CheckConclusion;
}

export interface CreatePrInput {
  owner: string;
  repo: string;
  head_branch: string;
  base_branch: string;
  title: string;
  body?: string;
  /** When true (default), open as draft. */
  draft?: boolean;
}

export interface MergePrInput {
  owner: string;
  repo: string;
  number: number;
  method: MergeMethod;
  commit_title?: string;
  commit_message?: string;
}

export interface MergePrResult {
  merged: boolean;
  sha?: string;
  message?: string;
}

/**
 * Injectable GitHub API surface used by forge ops.
 * Real binding may wrap `gh` CLI or REST; tests use {@link FakeGithubClient}.
 */
export interface GithubClient {
  findPrByHead(
    owner: string,
    repo: string,
    head_branch: string,
  ): Promise<GithubPr | null>;
  getPr(owner: string, repo: string, number: number): Promise<GithubPr | null>;
  createPr(input: CreatePrInput): Promise<GithubPr>;
  /** Convert draft → ready (undraft). No-op if already ready. */
  markReady(owner: string, repo: string, number: number): Promise<GithubPr>;
  getChecks(owner: string, repo: string, ref: string): Promise<CheckRun[]>;
  mergePr(input: MergePrInput): Promise<MergePrResult>;
}

export interface EnsureReadyPrRequest {
  owner: string;
  repo: string;
  head_branch: string;
  base_branch: string;
  title: string;
  body?: string;
  /**
   * Existing PR number from `run.pr_ref` (preferred).
   * Never open a second PR when this is set and the PR still exists.
   */
  existing_pr_number?: number;
  client: GithubClient;
}

export type EnsureReadyPrAction =
  | "created"
  | "undrafted"
  | "already_ready"
  | "found_existing";

export interface EnsureReadyPrResult {
  pr: GithubPr;
  action: EnsureReadyPrAction;
}

export interface PollChecksRequest {
  owner: string;
  repo: string;
  /** Branch name or commit SHA. */
  ref: string;
  /**
   * Required check names. Empty → all completed checks must be success
   * (or no checks yet counts as pending).
   */
  required_checks: readonly string[];
  client: GithubClient;
}

export interface PollChecksResult {
  head_ref: string;
  checks: CheckRun[];
  /** All required checks completed successfully (skipped counts as ok). */
  required_green: boolean;
  /** At least one required check failed / timed_out / cancelled. */
  required_failed: boolean;
  /** Waiting on queued/in_progress or missing required names. */
  pending: boolean;
  failed_checks: string[];
  pending_checks: string[];
}
