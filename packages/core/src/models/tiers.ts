/**
 * Tier ordering, score→tier bands, effort mapping.
 */

import { MODEL_TIERS, type ModelTier } from "../types/model-tier.js";
import { DEFAULT_SCORE_BANDS, TIER_BAND_MIDPOINT } from "./defaults.js";
import type { EffortLevel, ScoreBands } from "./types.js";

const TIER_INDEX: Readonly<Record<ModelTier, number>> = {
  nano: 0,
  small: 1,
  medium: 2,
  large: 3,
  xlarge: 4,
};

export function tierIndex(tier: ModelTier): number {
  return TIER_INDEX[tier];
}

/** Higher of two tiers (xlarge > … > nano). */
export function maxTier(a: ModelTier, b: ModelTier): ModelTier {
  return tierIndex(a) >= tierIndex(b) ? a : b;
}

/** Lower of two tiers. */
export function minTier(a: ModelTier, b: ModelTier): ModelTier {
  return tierIndex(a) <= tierIndex(b) ? a : b;
}

/** Single step up; clamps at xlarge. */
export function nextTier(tier: ModelTier): ModelTier {
  const i = tierIndex(tier);
  return MODEL_TIERS[Math.min(i + 1, MODEL_TIERS.length - 1)]!;
}

/** Single step down; clamps at nano. */
export function prevTier(tier: ModelTier): ModelTier {
  const i = tierIndex(tier);
  return MODEL_TIERS[Math.max(i - 1, 0)]!;
}

/** large/xlarge → high, medium → medium, else low. */
export function mapTierToEffort(tier: ModelTier): EffortLevel {
  if (tier === "large" || tier === "xlarge") return "high";
  if (tier === "medium") return "medium";
  return "low";
}

/**
 * Map score (0–100) to tier using inclusive bands.
 * Falls back to default bands; out-of-range scores clamp via band edges.
 */
export function scoreToTier(
  score: number,
  bands: ScoreBands = DEFAULT_SCORE_BANDS,
): ModelTier {
  const s = Number.isFinite(score) ? score : 0;
  for (const tier of MODEL_TIERS) {
    const [lo, hi] = bands[tier];
    if (s >= lo && s <= hi) return tier;
  }
  if (s < 0) return "nano";
  return "xlarge";
}

export function tierBandMidpoint(tier: ModelTier): number {
  return TIER_BAND_MIDPOINT[tier];
}

/**
 * Look up which tier a concrete model id maps to in a tier_map (first match).
 */
export function tierForModelId(
  modelId: string,
  tierMap: Partial<Record<ModelTier, string>>,
): ModelTier | undefined {
  for (const tier of MODEL_TIERS) {
    if (tierMap[tier] === modelId) return tier;
  }
  return undefined;
}
