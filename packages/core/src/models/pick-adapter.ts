/**
 * pickAdapter for the LLM path (KD-42 step 5–6).
 * Never selects shell as a coding fallback.
 */

import { MODEL_TIERS, type ModelTier } from "../types/model-tier.js";
import {
  DEFAULT_ADAPTERS_DEFAULT,
  DEFAULT_PREFERENCE_ORDER,
  defaultAdaptersForRouting,
} from "./defaults.js";
import { prevTier, tierForModelId, tierIndex } from "./tiers.js";
import type { AdapterRouteInfo } from "./types.js";

export interface PickAdapterInput {
  tier: ModelTier;
  /** Locked model string from pin (optional). */
  model_override?: string;
  adapter_override?: string;
  preferred_adapters?: string[];
  adapters?: AdapterRouteInfo[];
  adapters_default?: string;
  preference_order?: string[];
  pin_locked: boolean;
}

export interface PickAdapterResult {
  adapter_id: string;
  model: string;
  /** Tier after optional step-down (unpinned only). */
  tier: ModelTier;
  /** True when final tier is below the pre-step-down tier (unpinned). */
  stepped_down: boolean;
  error?: string;
}

function isHealthy(a: AdapterRouteInfo): boolean {
  return a.healthy !== false;
}

function isShell(a: AdapterRouteInfo): boolean {
  return a.is_shell === true || a.id === "shell";
}

function supportsTier(a: AdapterRouteInfo, tier: ModelTier): boolean {
  const m = a.tier_map[tier];
  return typeof m === "string" && m.length > 0;
}

function modelForTier(a: AdapterRouteInfo, tier: ModelTier): string | undefined {
  const m = a.tier_map[tier];
  return typeof m === "string" && m.length > 0 ? m : undefined;
}

/**
 * Resolve adapter + model for the LLM path.
 * Shell adapters are ignored on the preference_order path.
 */
export function pickAdapter(input: PickAdapterInput): PickAdapterResult {
  const adapters =
    input.adapters && input.adapters.length > 0
      ? input.adapters
      : defaultAdaptersForRouting();
  const byId = new Map(adapters.map((a) => [a.id, a]));
  const preference =
    input.preference_order && input.preference_order.length > 0
      ? input.preference_order
      : [...DEFAULT_PREFERENCE_ORDER];
  const adaptersDefault = input.adapters_default ?? DEFAULT_ADAPTERS_DEFAULT;
  const startTier = input.tier;

  const tryOne = (
    id: string,
    tier: ModelTier,
  ): { adapter_id: string; model: string } | null => {
    const a = byId.get(id);
    if (!a || !isHealthy(a) || isShell(a)) return null;
    if (input.model_override) {
      // Pin model: adapter must accept it (in tier_map values or any model list)
      const values = Object.values(a.tier_map);
      if (values.includes(input.model_override)) {
        return { adapter_id: a.id, model: input.model_override };
      }
      // Allow override string even if not in map when adapter_override targets this id
      if (input.adapter_override === a.id) {
        return { adapter_id: a.id, model: input.model_override };
      }
      return null;
    }
    if (!supportsTier(a, tier)) return null;
    const model = modelForTier(a, tier)!;
    return { adapter_id: a.id, model };
  };

  const orderedCandidates = (tier: ModelTier): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (id: string | undefined) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      out.push(id);
    };
    push(input.adapter_override);
    for (const id of input.preferred_adapters ?? []) push(id);
    push(adaptersDefault);
    for (const id of preference) {
      if (id === "shell") continue; // ignored on LLM path
      push(id);
    }
    // Also try any remaining healthy non-shell adapters
    for (const a of adapters) {
      if (!isShell(a) && isHealthy(a)) push(a.id);
    }
    void tier;
    return out;
  };

  // Pin locked: no silent step-down below intentional pin
  if (input.pin_locked) {
    for (const id of orderedCandidates(startTier)) {
      const hit = tryOne(id, startTier);
      if (hit) {
        return {
          adapter_id: hit.adapter_id,
          model: hit.model,
          tier: startTier,
          stepped_down: false,
        };
      }
    }
    return {
      adapter_id: input.adapter_override ?? adaptersDefault,
      model: input.model_override ?? "n/a",
      tier: startTier,
      stepped_down: false,
      error: "no adapter for pin",
    };
  }

  // Unpinned: try start tier, then step down nano-ward
  let tier: ModelTier = startTier;
  for (;;) {
    for (const id of orderedCandidates(tier)) {
      const hit = tryOne(id, tier);
      if (hit) {
        return {
          adapter_id: hit.adapter_id,
          model: hit.model,
          tier,
          stepped_down: tierIndex(tier) < tierIndex(startTier),
        };
      }
    }
    if (tier === "nano") break;
    tier = prevTier(tier);
  }

  return {
    adapter_id: adaptersDefault,
    model: "n/a",
    tier: startTier,
    stepped_down: false,
    error: "no adapter for tier",
  };
}

/**
 * Infer observability tier for a pinned model id across adapters.
 */
export function inferTierForModel(
  modelId: string,
  adapters: AdapterRouteInfo[],
): ModelTier | undefined {
  for (const a of adapters) {
    const t = tierForModelId(modelId, a.tier_map);
    if (t) return t;
  }
  // Search all known tiers for completeness
  for (const tier of MODEL_TIERS) {
    for (const a of adapters) {
      if (a.tier_map[tier] === modelId) return tier;
    }
  }
  return undefined;
}
