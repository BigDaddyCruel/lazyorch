export const MODEL_TIERS = ["nano", "small", "medium", "large", "xlarge"] as const;

export type ModelTier = (typeof MODEL_TIERS)[number];

const TIER_SET = new Set<string>(MODEL_TIERS);

/** Type guard for ModelTier. */
export function isModelTier(value: unknown): value is ModelTier {
  return typeof value === "string" && TIER_SET.has(value);
}

/**
 * Parse a ModelTier from unknown input.
 * @returns the tier or null if invalid
 */
export function parseModelTier(value: unknown): ModelTier | null {
  return isModelTier(value) ? value : null;
}
