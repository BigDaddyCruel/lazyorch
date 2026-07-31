/**
 * Injectable ports for the Implementing phase.
 * Core never depends on @lazyorch/adapters or @lazyorch/forge — only these ports.
 * Daemon binds real session runners + forge git; unit tests use fakes.
 */

import type { EffortLevel, RouteResult, SessionKind } from "../models/types.js";
import type { ModelTier } from "../types/model-tier.js";
import type { Task } from "../types/task.js";

// ---------------------------------------------------------------------------
// Worker session (LLM coding agent in worktree)
// ---------------------------------------------------------------------------

export type WorkerOutcomeKind =
  | "submit_for_review"
  | "fail"
  | "requeue"
  | "error"
  | "timeout"
  | "stall";

export interface WorkerSessionRequest {
  task: Task;
  agent_id: string;
  adapter_id: string;
  model: string;
  model_tier: ModelTier | null;
  session_kind: SessionKind;
  effort?: EffortLevel;
  worktree_path?: string;
  branch?: string;
  /**
   * When true, worker is fixing an integrate conflict (rebase onto feature tip).
   * Outcome may skip full review if only markers resolved.
   */
  integrate_conflict_rework?: boolean;
  cwd: string;
  run_handle?: string;
}

export interface WorkerSessionOutcome {
  kind: WorkerOutcomeKind;
  summary?: string;
  error_message?: string;
  /**
   * After conflict rework: if false, may go integrating without full review
   * (merge markers only). Default true when omitted for normal submit.
   */
  material_product_change?: boolean;
  artifacts?: string[];
  model_used?: string;
  adapter_id?: string;
  route?: RouteResult;
}

export interface WorkerSessionPort {
  run(req: WorkerSessionRequest): Promise<WorkerSessionOutcome>;
}

// ---------------------------------------------------------------------------
// Reviewer session (ephemeral code review)
// ---------------------------------------------------------------------------

export type ReviewDecision = "approve" | "reject" | "invalid";

export interface ReviewerSessionRequest {
  task: Task;
  agent_id: string;
  adapter_id: string;
  model: string;
  model_tier: ModelTier | null;
  session_kind: SessionKind;
  effort?: EffortLevel;
  cwd: string;
  run_handle?: string;
}

export interface ReviewerSessionOutcome {
  decision: ReviewDecision;
  summary?: string;
  error_message?: string;
  model_used?: string;
  adapter_id?: string;
  route?: RouteResult;
}

export interface ReviewerSessionPort {
  run(req: ReviewerSessionRequest): Promise<ReviewerSessionOutcome>;
}

// ---------------------------------------------------------------------------
// Run-level QA session (ephemeral; exit predicate re-QA at tip)
// ---------------------------------------------------------------------------

export interface QaSessionRequest {
  run_id: string;
  /** Feature tip SHA under test. */
  feature_tip_sha: string;
  feature_branch?: string;
  agent_id: string;
  adapter_id: string;
  model: string;
  model_tier: ModelTier | null;
  session_kind: SessionKind;
  effort?: EffortLevel;
  cwd: string;
  run_handle?: string;
  /** Optional acceptance hints from plan tasks. */
  acceptance_hints?: string[];
}

export interface QaSessionOutcome {
  /** true → record qa.passed_at_commit = tip */
  passed: boolean;
  summary?: string;
  error_message?: string;
  /** Optional dynamic fix task titles when failed. */
  fix_titles?: string[];
  model_used?: string;
  adapter_id?: string;
  route?: RouteResult;
}

/**
 * Injectable run-level QA port. Ephemeral session; clean exit free slot.
 * Real binding uses qa-runner skill + session runner.
 */
export interface QaSessionPort {
  run(req: QaSessionRequest): Promise<QaSessionOutcome>;
}

// ---------------------------------------------------------------------------
// Forge integrate (daemon git job — no agent slot; KD-33)
// ---------------------------------------------------------------------------

export type ForgeIntegrateStatus = "ok" | "conflict" | "error";

export interface ForgeIntegrateRequest {
  run_id: string;
  task_id: string;
  task_branch?: string;
  feature_branch?: string;
  worktree_path?: string;
  repo_root?: string;
}

export interface ForgeIntegrateResult {
  status: ForgeIntegrateStatus;
  feature_tip_sha?: string;
  error_message?: string;
  conflict?: boolean;
}

/**
 * Injectable forge integrate port (implements KD-33).
 * Real binding uses forge `integrateTaskBranch` under IntegrationMutex.
 */
export interface ForgeIntegratePort {
  integrate(req: ForgeIntegrateRequest): Promise<ForgeIntegrateResult>;
}

// ---------------------------------------------------------------------------
// Integration mutex port (global per-run serialize; KD-33/34)
// ---------------------------------------------------------------------------

export type IntegrationMutexAcquireResult =
  | { ok: true }
  | { ok: false; holder: string };

/**
 * Per-run integrate mutex. Compatible with forge `IntegrationMutex`.
 * Does not consume an agent slot.
 */
export interface IntegrationMutexPort {
  tryAcquire(runId: string, taskId: string): IntegrationMutexAcquireResult;
  release(runId: string): boolean;
  releaseIfHolder?(runId: string, taskId: string): boolean;
  holder(runId: string): string | undefined;
  isHeld(runId: string): boolean;
}
