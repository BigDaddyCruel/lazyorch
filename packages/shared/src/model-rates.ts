/**
 * Shared model rate table + token → USD estimates (PR-18).
 * Used by core (pressure/aggregation) and adapters (session tracker)
 * so estimators cannot drift.
 *
 * Rates are USD per million tokens (in / out).
 */

import type { ModelTier } from "./config/schema.js";

/** USD per million tokens (in / out). Mirrors budget.model_rates entries. */
export interface ModelRate {
  in_per_mtok: number;
  out_per_mtok: number;
}

/**
 * Design-doc style defaults for common model families (approximate).
 * Operator config `budget.model_rates` overrides / extends this table.
 */
export const DEFAULT_MODEL_RATES: Readonly<Record<string, ModelRate>> = {
  // Claude
  "claude-haiku-4-5": { in_per_mtok: 1.0, out_per_mtok: 5.0 },
  "claude-sonnet-4-6": { in_per_mtok: 3.0, out_per_mtok: 15.0 },
  "claude-opus-4-6": { in_per_mtok: 15.0, out_per_mtok: 75.0 },
  // OpenAI / Codex
  "o4-mini": { in_per_mtok: 1.1, out_per_mtok: 4.4 },
  "gpt-5": { in_per_mtok: 5.0, out_per_mtok: 15.0 },
  // Grok
  "grok-3-mini": { in_per_mtok: 0.3, out_per_mtok: 0.5 },
  "grok-3": { in_per_mtok: 3.0, out_per_mtok: 15.0 },
  "grok-4": { in_per_mtok: 5.0, out_per_mtok: 25.0 },
  // Generic / agy fallback
  default: { in_per_mtok: 2.0, out_per_mtok: 8.0 },
};

/**
 * Tier-level default rates when model id is unknown (design: tier-level defaults).
 */
export const DEFAULT_TIER_RATES: Readonly<Record<ModelTier, ModelRate>> = {
  nano: { in_per_mtok: 0.25, out_per_mtok: 1.0 },
  small: { in_per_mtok: 1.0, out_per_mtok: 4.0 },
  medium: { in_per_mtok: 3.0, out_per_mtok: 12.0 },
  large: { in_per_mtok: 5.0, out_per_mtok: 20.0 },
  xlarge: { in_per_mtok: 15.0, out_per_mtok: 75.0 },
};

export type ModelRatesTable = Readonly<Record<string, ModelRate>>;

/**
 * Merge operator model_rates over built-in defaults (operator wins).
 * Empty `{}` still keeps defaults — never wipe the table.
 */
export function mergeModelRates(
  operatorRates?: Readonly<Record<string, ModelRate>> | null,
): Record<string, ModelRate> {
  if (!operatorRates || Object.keys(operatorRates).length === 0) {
    return { ...DEFAULT_MODEL_RATES };
  }
  return {
    ...DEFAULT_MODEL_RATES,
    ...operatorRates,
  };
}

/**
 * Look up a rate for a model id.
 * Exact match → case-insensitive match → undefined.
 */
export function lookupModelRate(
  modelId: string | undefined | null,
  table: ModelRatesTable = DEFAULT_MODEL_RATES,
): ModelRate | undefined {
  if (!modelId || modelId === "n/a") return undefined;
  const direct = table[modelId];
  if (direct) return direct;
  const lower = modelId.toLowerCase();
  for (const [k, v] of Object.entries(table)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/**
 * Resolve rate: model table → tier default → generic "default" entry → null.
 */
export function resolveRate(params: {
  model?: string | null;
  tier?: ModelTier | null;
  rates?: ModelRatesTable;
}): ModelRate | null {
  const table = params.rates ?? DEFAULT_MODEL_RATES;
  const fromModel = lookupModelRate(params.model, table);
  if (fromModel) return fromModel;
  if (params.tier) {
    const tierRate = DEFAULT_TIER_RATES[params.tier];
    if (tierRate) return tierRate;
  }
  return table.default ?? DEFAULT_MODEL_RATES.default ?? null;
}

/**
 * Estimate USD from tokens + rates.
 * Returns null when no tokens, or rate cannot be resolved.
 */
export function estimateUsdFromTokens(params: {
  input_tokens?: number;
  output_tokens?: number;
  model?: string | null;
  tier?: ModelTier | null;
  rates?: ModelRatesTable;
}): number | null {
  const input = params.input_tokens ?? 0;
  const output = params.output_tokens ?? 0;
  if (input <= 0 && output <= 0) return null;

  const rateArgs: {
    model?: string | null;
    tier?: ModelTier | null;
    rates?: ModelRatesTable;
  } = {};
  if (params.model !== undefined) rateArgs.model = params.model;
  if (params.tier !== undefined) rateArgs.tier = params.tier;
  if (params.rates !== undefined) rateArgs.rates = params.rates;
  const rate = resolveRate(rateArgs);
  if (!rate) return null;

  return (
    (input / 1_000_000) * rate.in_per_mtok +
    (output / 1_000_000) * rate.out_per_mtok
  );
}

/**
 * Prefer adapter-reported estimated_usd; else estimate from tokens + rates.
 */
export function resolveEstimatedUsd(params: {
  estimated_usd?: number;
  input_tokens?: number;
  output_tokens?: number;
  model?: string | null;
  tier?: ModelTier | null;
  rates?: ModelRatesTable;
}): { estimated_usd: number | null; source: "adapter" | "rates" | "none" } {
  if (
    params.estimated_usd !== undefined &&
    Number.isFinite(params.estimated_usd) &&
    params.estimated_usd >= 0
  ) {
    return { estimated_usd: params.estimated_usd, source: "adapter" };
  }
  const estArgs: {
    input_tokens?: number;
    output_tokens?: number;
    model?: string | null;
    tier?: ModelTier | null;
    rates?: ModelRatesTable;
  } = {};
  if (params.input_tokens !== undefined) {
    estArgs.input_tokens = params.input_tokens;
  }
  if (params.output_tokens !== undefined) {
    estArgs.output_tokens = params.output_tokens;
  }
  if (params.model !== undefined) estArgs.model = params.model;
  if (params.tier !== undefined) estArgs.tier = params.tier;
  if (params.rates !== undefined) estArgs.rates = params.rates;
  const fromRates = estimateUsdFromTokens(estArgs);
  if (fromRates !== null) {
    return { estimated_usd: fromRates, source: "rates" };
  }
  return { estimated_usd: null, source: "none" };
}
