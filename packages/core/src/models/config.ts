/**
 * Merge partial models routing config over design defaults.
 */

import {
  DEFAULT_COMPLEXITY_WEIGHTS,
  DEFAULT_MODELS_ROUTING_CONFIG,
  DEFAULT_ROLE_BASE,
  DEFAULT_SCORE_BANDS,
} from "./defaults.js";
import type {
  ComplexityWeights,
  ModelsRoutingConfig,
  PartialDeepModelsConfig,
  ScoreBands,
} from "./types.js";

export function mergeModelsConfig(
  partial?: PartialDeepModelsConfig,
): ModelsRoutingConfig {
  const base = DEFAULT_MODELS_ROUTING_CONFIG;
  if (!partial) {
    return {
      ...base,
      role_tier_floor: { ...base.role_tier_floor },
      role_tier_ceiling: { ...base.role_tier_ceiling },
      score_bands: { ...base.score_bands },
      complexity_weights: cloneWeights(base.complexity_weights),
    };
  }

  const weights = mergeWeights(partial.complexity_weights);
  const bands: ScoreBands = {
    ...DEFAULT_SCORE_BANDS,
    ...(partial.score_bands ?? {}),
  };

  return {
    routing_enabled:
      partial.routing_enabled ?? base.routing_enabled,
    strict_role_floors:
      partial.strict_role_floors ?? base.strict_role_floors,
    escalate_on_failure:
      partial.escalate_on_failure ?? base.escalate_on_failure,
    escalate_after_failures:
      partial.escalate_after_failures ?? base.escalate_after_failures,
    max_tier: partial.max_tier ?? base.max_tier,
    budget_tier_cap: partial.budget_tier_cap ?? base.budget_tier_cap,
    role_tier_floor: {
      ...base.role_tier_floor,
      ...(partial.role_tier_floor ?? {}),
    },
    role_tier_ceiling: {
      ...base.role_tier_ceiling,
      ...(partial.role_tier_ceiling ?? {}),
    },
    score_bands: bands,
    complexity_weights: weights,
  };
}

function mergeWeights(
  partial?: PartialDeepModelsConfig["complexity_weights"],
): ComplexityWeights {
  if (!partial) return cloneWeights(DEFAULT_COMPLEXITY_WEIGHTS);
  const { role_base, ...rest } = partial;
  return {
    ...DEFAULT_COMPLEXITY_WEIGHTS,
    ...rest,
    role_base: {
      ...DEFAULT_ROLE_BASE,
      ...(role_base ?? {}),
    },
  };
}

function cloneWeights(w: ComplexityWeights): ComplexityWeights {
  return {
    ...w,
    role_base: { ...w.role_base },
  };
}
