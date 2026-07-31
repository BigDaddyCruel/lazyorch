/**
 * Daemon API types (client-side mirrors of OpenAPI / HTTP stubs).
 *
 * Follow-up: generate or import from a shared OpenAPI/TS package when
 * run-detail / gate HTTP lands (design: shared API client types).
 */

export const RUN_PHASES = [
  "Inception",
  "Planning",
  "PlanConsensus",
  "Implementing",
  "PrePR",
  "PROpen",
  "CILoop",
  "MergeReady",
  "Merged",
  "Cancelled",
  "Failed",
] as const;

export type RunPhase = (typeof RUN_PHASES)[number];

export const TASK_STATUSES = [
  "todo",
  "ready",
  "in_progress",
  "review",
  "integrating",
  "done",
  "failed",
  "cancelled",
  "blocked",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const MODEL_TIERS = ["nano", "small", "medium", "large", "xlarge"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export const GATE_STATUSES = ["pending", "approved", "rejected", "timed_out"] as const;
export type GateStatus = (typeof GATE_STATUSES)[number];

export type GateType =
  | "plan_approve"
  | "plan_dispute"
  | "plan_max_rounds"
  | "task_approve"
  | "merge"
  | "destructive_git"
  | "budget_override"
  | "human_intervention";

export type AdapterHealth = "ok" | "degraded" | "error" | "unknown" | "missing";

export interface HealthResponse {
  ok: boolean;
  status: string;
  api_major: number;
  host: string;
  port: number;
  started_at: string;
  pid: number;
}

export interface RegisteredProject {
  id: string;
  repo_root: string;
  name?: string;
  registered_at?: string;
}

export interface StatusResponse {
  ok: boolean;
  api_major: number;
  started_at: string;
  project_count: number;
  run_count: number;
  projects: RegisteredProject[];
}

export interface DaemonRun {
  id: string;
  project_id: string;
  phase: string;
  idea?: string;
  created_at: string;
  updated_at?: string;
}

export interface AdapterInfo {
  id: string;
  source: string;
  health: AdapterHealth | string;
  capabilities?: {
    models?: boolean;
    cancel?: boolean;
  };
}

export interface AdaptersResponse {
  adapters: AdapterInfo[];
  stub?: boolean;
}

export interface ModelRouteResponse {
  stub?: boolean;
  role: string;
  task_id: string | null;
  tier: string;
  adapter_id: string;
  model: string;
  reason: string;
}

export interface EventEnvelope {
  id: string;
  ts: string;
  type: string;
  project_id?: string;
  run_id?: string;
  payload?: Record<string, unknown>;
}

/** Enriched board models (HTTP stubs + demo fill-in until full run APIs land). */
export interface BoardTask {
  id: string;
  run_id: string;
  title: string;
  status: TaskStatus;
  priority: 1 | 2 | 3 | 4;
  assignee?: string;
  role_affinity?: string[];
  last_model_tier?: ModelTier | string;
  last_adapter_id?: string;
  last_model_id?: string;
  blocked_reason?: string;
}

export interface BoardGate {
  id: string;
  type: GateType | string;
  run_id: string;
  status: GateStatus | string;
  created_at: string;
  payload?: Record<string, unknown>;
}

export interface BoardAgent {
  id: string;
  run_id: string;
  role: string;
  labels: string[];
  preferred_adapters: string[];
  default_tier?: ModelTier | string;
  session_status?: "idle" | "running" | "stopped" | "error";
  last_adapter_id?: string;
  last_model_id?: string;
  last_model_tier?: ModelTier | string;
}

export interface BoardPlan {
  id: string;
  run_id: string;
  revision: number;
  status: "draft" | "in_review" | "frozen" | "superseded" | string;
  task_ids: string[];
  issues: Array<{
    id: string;
    severity: string;
    category: string;
    section: string;
    description: string;
    status: string;
  }>;
  residual_risks?: string[];
  freeze_hash?: string;
  updated_at: string;
}

export interface BoardRun extends DaemonRun {
  phase: RunPhase | string;
  idea: string;
  tasks: BoardTask[];
  gates: BoardGate[];
  agents: BoardAgent[];
  plan?: BoardPlan;
  feature_branch?: string;
}

export interface DaemonClientConfig {
  baseUrl: string;
  token?: string;
  /** When true, use demo board data if daemon has empty runs. */
  useDemoFallback?: boolean;
  fetchImpl?: typeof fetch;
}
