/**
 * Complexity estimator — normative KD-41 formula.
 * score = role base + capped additives + soft prior, clamp 0..100.
 * Role floors/ceilings are NOT applied here (router only).
 */

import type { ModelTier } from "../types/model-tier.js";
import {
  DEFAULT_COMPLEXITY_WEIGHTS,
  DEFAULT_SCORE_BANDS,
  DEFAULT_UNKNOWN_ROLE_BASE,
} from "./defaults.js";
import { scoreToTier, tierBandMidpoint } from "./tiers.js";
import type {
  ComplexitySignals,
  ComplexityWeights,
  EstimateResult,
  ScoreBands,
} from "./types.js";

const SECURITY_RISK_LABELS = new Set([
  "security",
  "public_api",
  "data_migration",
]);

export function clampScore(score: number): number {
  return Math.min(100, Math.max(0, Math.round(score)));
}

export function roleBase(
  role: string,
  weights: ComplexityWeights = DEFAULT_COMPLEXITY_WEIGHTS,
): number {
  const base = weights.role_base[role];
  return typeof base === "number" ? base : DEFAULT_UNKNOWN_ROLE_BASE;
}

/** Exactly one loc_* bucket from scope_loc_est. */
export function locBucket(
  scopeLocEst: number | undefined,
  weights: ComplexityWeights = DEFAULT_COMPLEXITY_WEIGHTS,
): number {
  if (scopeLocEst === undefined || scopeLocEst <= 0) return weights.loc_0;
  if (scopeLocEst <= 50) return weights.loc_1_50;
  if (scopeLocEst <= 200) return weights.loc_51_200;
  if (scopeLocEst <= 800) return weights.loc_201_800;
  return weights.loc_801_plus;
}

/**
 * Plan soft prior: move score toward plan tier midpoint by at most
 * ±plan_soft_prior_points.
 */
export function planTierSoftPrior(
  planEstimateTier: ModelTier | undefined,
  score: number,
  weights: ComplexityWeights = DEFAULT_COMPLEXITY_WEIGHTS,
): number {
  if (!planEstimateTier) return 0;
  const mid = tierBandMidpoint(planEstimateTier);
  const delta = mid - score;
  const cap = weights.plan_soft_prior_points;
  return Math.min(cap, Math.max(-cap, delta));
}

export function securityRiskHit(signals: ComplexitySignals): boolean {
  if (signals.task_type_labels.includes("security")) return true;
  return signals.risk_labels.some((r) => SECURITY_RISK_LABELS.has(r));
}

/**
 * Estimate complexity score and suggested tier before overrides (KD-41).
 */
export function estimateComplexity(
  signals: ComplexitySignals,
  weights: ComplexityWeights = DEFAULT_COMPLEXITY_WEIGHTS,
  bands: ScoreBands = DEFAULT_SCORE_BANDS,
): EstimateResult {
  let score = roleBase(signals.role, weights);

  score += Math.min(
    weights.scope_path_cap,
    signals.scope_path_count * weights.scope_path_points,
  );
  score += locBucket(signals.scope_loc_est, weights);
  score += Math.min(
    weights.depends_cap,
    signals.depends_on_count * weights.depends_points,
  );
  score += Math.min(
    weights.acceptance_cap,
    signals.acceptance_command_count * weights.acceptance_points,
  );
  score += Math.min(
    weights.title_desc_cap,
    Math.floor(signals.title_desc_chars / weights.title_desc_chars_per_point),
  );

  if (signals.is_critical_path) score += weights.critical_path_points;
  score += Math.max(0, signals.prior_failures) * weights.prior_failure_points;

  if (securityRiskHit(signals)) score += weights.security_risk_points;

  score += planTierSoftPrior(signals.plan_estimate_tier, score, weights);
  score = clampScore(score);

  return { score, tier: scoreToTier(score, bands) };
}

/** Build signals with design defaults for omitted fields. */
export function normalizeSignals(
  partial: Partial<ComplexitySignals> & { role: string },
): ComplexitySignals {
  const out: ComplexitySignals = {
    role: partial.role,
    task_origin: partial.task_origin ?? "plan",
    task_type_labels: partial.task_type_labels ?? [],
    scope_path_count: partial.scope_path_count ?? 0,
    depends_on_count: partial.depends_on_count ?? 0,
    is_critical_path: partial.is_critical_path ?? false,
    prior_failures: partial.prior_failures ?? 0,
    risk_labels: partial.risk_labels ?? [],
    acceptance_command_count: partial.acceptance_command_count ?? 0,
    title_desc_chars: partial.title_desc_chars ?? 0,
  };
  if (partial.scope_loc_est !== undefined) {
    out.scope_loc_est = partial.scope_loc_est;
  }
  if (partial.plan_estimate_tier !== undefined) {
    out.plan_estimate_tier = partial.plan_estimate_tier;
  }
  return out;
}
