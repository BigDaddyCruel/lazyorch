/**
 * Model complexity router types (KD-38 / KD-41 / KD-42).
 */

import type { ModelTier } from "../types/model-tier.js";

/** Signals collected for the complexity estimator (design ComplexitySignals). */
export interface ComplexitySignals {
  role: string;
  task_origin: "plan" | "dynamic";
  task_type_labels: string[];
  scope_path_count: number;
  /** Optional LOC estimate; 0 / missing → loc_0 bucket. */
  scope_loc_est?: number;
  depends_on_count: number;
  is_critical_path: boolean;
  /** max(0, attempt - 1) */
  prior_failures: number;
  risk_labels: string[];
  /** Optional author hint on TASK_DAG node. */
  plan_estimate_tier?: ModelTier;
  acceptance_command_count: number;
  title_desc_chars: number;
}

export type SessionKind = "llm" | "deterministic";

export type RouteReason =
  | "estimate"
  | "override"
  | "escalate"
  | "budget_cap"
  | "tier_map_gap"
  | "routing_disabled"
  | "deterministic";

export type EffortLevel = "low" | "medium" | "high";

/** Pin sources: task > run/CLI/GUI > lead. */
export interface ModelPin {
  tier_override?: ModelTier;
  model_override?: string;
  adapter_override?: string;
}

export interface ComplexityWeights {
  role_base: Record<string, number>;
  scope_path_points: number;
  scope_path_cap: number;
  loc_0: number;
  loc_1_50: number;
  loc_51_200: number;
  loc_201_800: number;
  loc_801_plus: number;
  depends_points: number;
  depends_cap: number;
  acceptance_points: number;
  acceptance_cap: number;
  title_desc_chars_per_point: number;
  title_desc_cap: number;
  critical_path_points: number;
  prior_failure_points: number;
  security_risk_points: number;
  plan_soft_prior_points: number;
}

/** Inclusive [lo, hi] score band per tier. */
export type ScoreBands = Record<ModelTier, readonly [number, number]>;

/**
 * Router-facing models config subset.
 * Mirrors design `models:` keys used by the estimator + router.
 */
export interface ModelsRoutingConfig {
  routing_enabled: boolean;
  strict_role_floors: boolean;
  escalate_on_failure: boolean;
  escalate_after_failures: number;
  max_tier: ModelTier;
  budget_tier_cap: ModelTier;
  role_tier_floor: Record<string, ModelTier>;
  role_tier_ceiling: Record<string, ModelTier>;
  score_bands: ScoreBands;
  complexity_weights: ComplexityWeights;
}

/** Adapter view used by pickAdapter (no dependency on @lazyorch/adapters). */
export interface AdapterRouteInfo {
  id: string;
  /** When false/undefined, skipped. Default true when omitted for dry-run. */
  healthy?: boolean;
  /** tier → concrete model id */
  tier_map: Partial<Record<ModelTier, string>>;
  /** When true, treated as deterministic shell (never selected on LLM path). */
  is_shell?: boolean;
}

export interface EscalateContext {
  consecutive_quality_fails: number;
  last_model_tier?: ModelTier;
}

export interface RouteInput {
  role: string;
  task_id?: string;
  /** Full or partial signals; role is taken from `role` when signals.role omitted. */
  signals?: Partial<ComplexitySignals>;
  task_pin?: ModelPin;
  run_pin?: ModelPin;
  lead_pin?: ModelPin;
  /**
   * Deterministic path when `"deterministic"`, or when any pin has
   * `adapter_override: "shell"` (design shell vs LLM table).
   */
  session_kind?: SessionKind;
  escalate?: EscalateContext;
  /** True when remaining USD/hours is below pressure threshold. */
  budget_pressure?: boolean;
  preferred_adapters?: string[];
  /** Partial override of routing config (merged over defaults). */
  config?: PartialDeepModelsConfig;
  /** Available adapters for pickAdapter; defaults to design tier-map catalog. */
  adapters?: AdapterRouteInfo[];
  adapters_default?: string;
  preference_order?: string[];
}

/** Deep-partial for nested models config fields used by the router. */
export type PartialDeepModelsConfig = {
  routing_enabled?: boolean;
  strict_role_floors?: boolean;
  escalate_on_failure?: boolean;
  escalate_after_failures?: number;
  max_tier?: ModelTier;
  budget_tier_cap?: ModelTier;
  role_tier_floor?: Record<string, ModelTier>;
  role_tier_ceiling?: Record<string, ModelTier>;
  score_bands?: Partial<ScoreBands>;
  complexity_weights?: Partial<ComplexityWeights> & {
    role_base?: Record<string, number>;
  };
};

export interface RouteResult {
  session_kind: SessionKind;
  /** Complexity score when estimator ran; omitted on deterministic path. */
  score?: number;
  /** null on deterministic path. */
  tier: ModelTier | null;
  adapter_id: string;
  model: string;
  reason: RouteReason;
  floor_violated: boolean;
  pin_locked: boolean;
  effort?: EffortLevel;
  /** Set when routing cannot pick an adapter / pin cannot be satisfied. */
  error?: string;
}

/**
 * `model.routed` event payload shape (design EventEnvelope).
 * Pure helper — daemon emit is separate.
 */
export interface ModelRoutedPayload {
  task_id?: string;
  role: string;
  score?: number;
  tier?: ModelTier | null;
  adapter_id: string;
  model: string;
  reason: RouteReason;
  floor_violated?: boolean;
}

export interface EstimateResult {
  score: number;
  tier: ModelTier;
}
