/**
 * Session / adapter contracts (design-lazyorch KD-40).
 * Shared by the session runner and all adapters.
 */

import type { ModelTier } from "@lazyorch/shared";

export type AdapterId = string;

export type SessionKind = "llm" | "deterministic";

export type SessionStatus =
  | "ok"
  | "error"
  | "cancelled"
  | "timeout"
  | "stall";

export type EffortLevel = "low" | "medium" | "high";

export type ApprovalPolicy = "auto" | "suggest" | "manual";

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  estimated_usd?: number;
}

export interface DoctorResult {
  ok: boolean;
  adapter_id: AdapterId;
  binary_path?: string;
  version?: string;
  message: string;
  unbound?: boolean;
  capabilities_probe?: Record<string, unknown>;
}

/** Injected runtime facts; never secrets. */
export interface ContextBundle {
  freeze_hash: string;
  plan_dir: string;
  task?: SessionTaskBlob;
  context_kv: Record<string, unknown>;
  feature_branch: string;
  feature_tip_sha?: string;
  run_id: string;
  project_root: string;
}

/** Task fields needed for prompt materialization / result mapping. */
export interface SessionTaskBlob {
  id: string;
  title: string;
  description: string;
  scope: string[];
  acceptance: string[];
  review_criteria: string[];
  attempt?: number;
  max_attempts?: number;
  status?: string;
}

export type ReviewDecision = {
  kind: "review";
  decision: "approve" | "reject";
  comments?: string;
};

export type QaDecision = {
  kind: "qa";
  passed: boolean;
  summary?: string;
};

export type WorkerMarker = {
  kind: "worker";
  submitted: boolean;
  notes?: string;
};

export type StructuredDecision = ReviewDecision | QaDecision | WorkerMarker;

export interface SessionResult {
  status: SessionStatus;
  usage?: Usage;
  summary?: string;
  exit_code?: number;
  model_used?: string;
  adapter_id?: AdapterId;
  decision?: StructuredDecision;
  raw_result_path?: string;
}

export interface RunningAgent {
  run_handle: string;
  pid: number;
  adapter_id: AdapterId;
  agent_id: string;
  task_id?: string;
  session_dir: string;
  started_at: string;
  /** Resolves when process exits (or runner timeout/stall/cancel applied). */
  wait(): Promise<SessionResult>;
  /** Tail path for operator logs (stdio capture). */
  log_path: string;
}

export interface AgentSession {
  agent_id: string;
  task_id?: string;
  role: string;
  role_prompt: string;
  skills: string[];
  adapter_id: AdapterId;
  model: string;
  model_tier: ModelTier | null;
  session_kind: SessionKind;
  effort?: EffortLevel;
  cwd: string;
  env: Record<string, string>;
  max_turns: number;
  timeout_ms: number;
  approval_policy: ApprovalPolicy;
  context: ContextBundle;
  complexity_score?: number;
  /** Deterministic/shell only: command argv after allowlist check */
  command?: string[];
  session_dir?: string;
  prompt_file?: string;
}

/**
 * Adapter maps AgentSession → argv/env/stdio only.
 * Does not own timeout/stall/cancel process-tree kill or prompt materialization.
 */
export interface AgentAdapter {
  readonly id: AdapterId;
  doctor(): Promise<DoctorResult>;
  listModels?(): Promise<string[]>;
  start(session: AgentSession): Promise<RunningAgent>;
  /** Best-effort cancel hook; runner always falls back to process-tree kill. */
  cancel(runHandle: string): Promise<void>;
}

/** Durable pid table entry under runs/<run_id>/sessions.json */
export interface SessionRecord {
  run_handle: string;
  pid: number;
  adapter_id: AdapterId;
  agent_id: string;
  task_id?: string;
  role: string;
  started_at: string;
  session_dir: string;
  log_path: string;
  status: "running" | SessionStatus;
  ended_at?: string;
}

export interface SessionsFile {
  schema_version: 1;
  sessions: Record<string, SessionRecord>;
}

/** meta.json written by the session runner before spawn. */
export interface SessionMeta {
  run_handle: string;
  agent_id: string;
  task_id?: string;
  role: string;
  adapter_id: AdapterId;
  model: string;
  model_tier: ModelTier | null;
  session_kind: SessionKind;
  complexity_score?: number;
  started_at: string;
  timeout_ms: number;
  freeze_hash: string;
  cwd: string;
}
