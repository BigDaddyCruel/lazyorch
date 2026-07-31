import type {
  EffortLevel,
  ModelPin,
  ModelsRoutingConfig,
  RouteInput,
  RouteResult,
  SessionKind,
  AdapterRouteInfo,
  PartialDeepModelsConfig,
} from "../models/types.js";
import type { ModelTier } from "../types/model-tier.js";
import type {
  PlanReviewContext,
  PlanReviewResult,
  PlanWriteContext,
  PlanWriteResult,
} from "./types.js";

/**
 * Plan writer port — produces DESIGN + TASK_DAG + PR_PLAN (and issue responses).
 * Real adapters bind LLM sessions; tests use {@link FakePlanWriter}.
 */
export interface PlanWriterPort {
  write(ctx: PlanWriteContext): Promise<PlanWriteResult>;
}

/**
 * Plan reviewer port — checklist review returning structured PlanIssue[].
 * Real adapters bind LLM sessions; tests use {@link FakePlanReviewer}.
 */
export interface PlanReviewerPort {
  review(ctx: PlanReviewContext): Promise<PlanReviewResult>;
}

/** Role used for planning sessions. */
export type PlanningRole = "plan_writer" | "plan_reviewer";

/**
 * Injectable session runner port for planning (adapters implement; tests use fakes).
 * Core never depends on @lazyorch/adapters — only this port.
 */
export interface PlanningSessionPort {
  run(req: PlanningSessionRequest): Promise<PlanningSessionOutcome>;
}

/**
 * One planning session invocation (write or review revision).
 * Mirrors the AgentSession subset needed for routing + materialize later.
 */
export interface PlanningSessionRequest {
  role: PlanningRole;
  agent_id: string;
  adapter_id: string;
  model: string;
  model_tier: ModelTier | null;
  session_kind: SessionKind;
  effort?: EffortLevel;
  complexity_score?: number;
  skills: string[];
  role_prompt: string;
  /** Write context when role is plan_writer. */
  write_ctx?: PlanWriteContext;
  /** Review context when role is plan_reviewer. */
  review_ctx?: PlanReviewContext;
  /** Project / cwd for adapter spawn. */
  cwd: string;
  env?: Record<string, string>;
  max_turns?: number;
  timeout_ms?: number;
  approval_policy?: "auto" | "suggest" | "manual";
  /** Opaque handle for correlating sessions (tests / runner). */
  run_handle?: string;
}

/** Outcome of a planning session (parsed artifacts, not raw process). */
export interface PlanningSessionOutcome {
  status: "ok" | "error" | "cancelled" | "timeout" | "stall";
  /** When role was plan_writer and status ok. */
  write?: PlanWriteResult;
  /** When role was plan_reviewer and status ok. */
  review?: PlanReviewResult;
  model_used?: string;
  adapter_id?: string;
  summary?: string;
  error_message?: string;
  /** Echo of the request route for observability / tests. */
  route?: RouteResult;
}

/** Routing knobs for plan_writer / plan_reviewer sessions. */
export interface PlanningRoutingOptions {
  config?: PartialDeepModelsConfig | Partial<ModelsRoutingConfig>;
  adapters?: AdapterRouteInfo[];
  adapters_default?: string;
  preference_order?: string[];
  run_pin?: ModelPin;
  lead_pin?: ModelPin;
  /** Per-role preferred adapters (overrides agent.preferred_adapters when set). */
  preferred_adapters_by_role?: Partial<Record<PlanningRole, readonly string[]>>;
  budget_pressure?: boolean;
  routeFn?: (input: RouteInput) => RouteResult;
}
