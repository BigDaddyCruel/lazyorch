/**
 * Normative defaults for complexity estimator + router (KD-41 / design models:).
 */

import type { ModelTier } from "../types/model-tier.js";
import type {
  ComplexityWeights,
  ModelsRoutingConfig,
  ScoreBands,
  AdapterRouteInfo,
} from "./types.js";

/** Default role base scores (models.complexity_weights.role_base). */
export const DEFAULT_ROLE_BASE: Readonly<Record<string, number>> = {
  plan_writer: 70,
  plan_reviewer: 70,
  lead: 50,
  reviewer: 45,
  worker: 30,
  qa: 25,
};

/** Unknown roles use this base. */
export const DEFAULT_UNKNOWN_ROLE_BASE = 30;

export const DEFAULT_COMPLEXITY_WEIGHTS: ComplexityWeights = {
  role_base: { ...DEFAULT_ROLE_BASE },
  scope_path_points: 3,
  scope_path_cap: 24,
  loc_0: 0,
  loc_1_50: 4,
  loc_51_200: 10,
  loc_201_800: 18,
  loc_801_plus: 28,
  depends_points: 2,
  depends_cap: 12,
  acceptance_points: 2,
  acceptance_cap: 10,
  title_desc_chars_per_point: 120,
  title_desc_cap: 8,
  critical_path_points: 10,
  prior_failure_points: 15,
  security_risk_points: 20,
  plan_soft_prior_points: 8,
};

/** Inclusive score bands — stable contract for unit tests. */
export const DEFAULT_SCORE_BANDS: ScoreBands = {
  nano: [0, 20],
  small: [21, 40],
  medium: [41, 60],
  large: [61, 80],
  xlarge: [81, 100],
};

/** Midpoint of each band for plan soft prior. */
export const TIER_BAND_MIDPOINT: Readonly<Record<ModelTier, number>> = {
  nano: 10,
  small: 30,
  medium: 50,
  large: 70,
  xlarge: 90,
};

export const DEFAULT_ROLE_TIER_FLOOR: Readonly<Record<string, ModelTier>> = {
  plan_writer: "large",
  plan_reviewer: "large",
  lead: "medium",
  reviewer: "medium",
  worker: "small",
  qa: "small",
};

/** Design default adapters.models / capability tier maps. */
export const DEFAULT_TIER_MAPS: Readonly<
  Record<string, Partial<Record<ModelTier, string>>>
> = {
  claude: {
    nano: "claude-haiku-4-5",
    small: "claude-haiku-4-5",
    medium: "claude-sonnet-4-6",
    large: "claude-sonnet-4-6",
    xlarge: "claude-opus-4-6",
  },
  codex: {
    small: "o4-mini",
    medium: "o4-mini",
    large: "gpt-5",
    xlarge: "gpt-5",
  },
  grok: {
    small: "grok-3-mini",
    medium: "grok-3",
    large: "grok-3",
    xlarge: "grok-4",
  },
  agy: {
    small: "default",
    medium: "default",
    large: "default",
    xlarge: "default",
  },
};

export const DEFAULT_PREFERENCE_ORDER = [
  "claude",
  "codex",
  "grok",
  "agy",
  "shell",
] as const;

export const DEFAULT_ADAPTERS_DEFAULT = "claude";

export const DEFAULT_MODELS_ROUTING_CONFIG: ModelsRoutingConfig = {
  routing_enabled: true,
  strict_role_floors: false,
  escalate_on_failure: true,
  escalate_after_failures: 1,
  max_tier: "xlarge",
  budget_tier_cap: "medium",
  role_tier_floor: { ...DEFAULT_ROLE_TIER_FLOOR },
  role_tier_ceiling: {},
  score_bands: { ...DEFAULT_SCORE_BANDS },
  complexity_weights: {
    ...DEFAULT_COMPLEXITY_WEIGHTS,
    role_base: { ...DEFAULT_ROLE_BASE },
  },
};

/** Default healthy coding adapters for dry-run / unit tests. */
export function defaultAdaptersForRouting(): AdapterRouteInfo[] {
  return Object.entries(DEFAULT_TIER_MAPS).map(([id, tier_map]) => ({
    id,
    healthy: true,
    tier_map: { ...tier_map },
    is_shell: false,
  }));
}
