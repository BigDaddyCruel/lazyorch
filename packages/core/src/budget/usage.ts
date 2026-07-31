/**
 * Usage aggregation from adapter sessions (PR-18).
 * Pure helpers — no I/O. Sessions feed Usage records; this sums them.
 */

import type { ModelTier } from "../types/model-tier.js";
import {
  mergeModelRates,
  resolveEstimatedUsd,
  type ModelRate,
  type ModelRatesTable,
} from "./model-rates.js";

/** Session-level usage blob (mirrors adapters Usage + optional model/tier). */
export interface SessionUsage {
  input_tokens?: number;
  output_tokens?: number;
  estimated_usd?: number;
  model?: string | null;
  tier?: ModelTier | null;
  /** Session / run handle for debugging. */
  run_handle?: string;
  role?: string;
}

export interface AggregatedUsage {
  input_tokens: number;
  output_tokens: number;
  /**
   * Best-effort sum of estimated_usd (adapter-reported or rate-derived).
   * Only sessions that contributed a known USD are included.
   */
  estimated_usd: number;
  /** Sessions that contributed token counts. */
  sessions_with_tokens: number;
  /** Sessions that contributed a known USD figure. */
  sessions_with_usd: number;
  /** Total sessions aggregated. */
  sessions: number;
  /**
   * True when every session either contributed USD or had no token usage
   * (deterministic / empty). Used for full-USD hard-stop confidence.
   */
  usd_complete: boolean;
  /**
   * True when at least one session contributed a known estimated_usd.
   * USD hard-stop / pressure may use estimated_usd when this is true.
   */
  usd_known: boolean;
}

export interface AggregateUsageOptions {
  /** Operator + default model rates for token→USD fill-in. */
  model_rates?: Readonly<Record<string, ModelRate>> | null;
  /**
   * When true (default), fill missing estimated_usd from tokens + rates.
   * When false, only sum adapter-reported estimated_usd.
   */
  estimate_missing?: boolean;
}

/**
 * Aggregate Usage records from adapter sessions.
 * Prefer adapter `estimated_usd`; else estimate from tokens + model_rates.
 */
export function aggregateUsage(
  sessions: readonly SessionUsage[],
  options: AggregateUsageOptions = {},
): AggregatedUsage {
  const estimateMissing = options.estimate_missing !== false;
  const rates: ModelRatesTable = mergeModelRates(options.model_rates ?? null);

  let input_tokens = 0;
  let output_tokens = 0;
  let estimated_usd = 0;
  let sessions_with_tokens = 0;
  let sessions_with_usd = 0;
  let sessions_without_usd_but_tokens = 0;

  for (const s of sessions) {
    const hasIn = s.input_tokens !== undefined && Number.isFinite(s.input_tokens);
    const hasOut =
      s.output_tokens !== undefined && Number.isFinite(s.output_tokens);
    if (hasIn) input_tokens += s.input_tokens as number;
    if (hasOut) output_tokens += s.output_tokens as number;
    if (hasIn || hasOut) sessions_with_tokens += 1;

    let usd: number | null = null;
    if (
      s.estimated_usd !== undefined &&
      Number.isFinite(s.estimated_usd) &&
      s.estimated_usd >= 0
    ) {
      usd = s.estimated_usd;
    } else if (estimateMissing && (hasIn || hasOut)) {
      const estArgs: Parameters<typeof resolveEstimatedUsd>[0] = { rates };
      if (s.input_tokens !== undefined) estArgs.input_tokens = s.input_tokens;
      if (s.output_tokens !== undefined) estArgs.output_tokens = s.output_tokens;
      if (s.model !== undefined) estArgs.model = s.model;
      if (s.tier !== undefined) estArgs.tier = s.tier;
      const resolved = resolveEstimatedUsd(estArgs);
      usd = resolved.estimated_usd;
    }

    if (usd !== null) {
      estimated_usd += usd;
      sessions_with_usd += 1;
    } else if (hasIn || hasOut) {
      sessions_without_usd_but_tokens += 1;
    }
  }

  const usd_known = sessions_with_usd > 0;
  const usd_complete =
    sessions.length === 0 || sessions_without_usd_but_tokens === 0;

  return {
    input_tokens,
    output_tokens,
    estimated_usd,
    sessions_with_tokens,
    sessions_with_usd,
    sessions: sessions.length,
    usd_complete,
    usd_known,
  };
}

/** Sum two AggregatedUsage snapshots (e.g. closed + open partial). */
export function mergeAggregatedUsage(
  a: AggregatedUsage,
  b: AggregatedUsage,
): AggregatedUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    estimated_usd: a.estimated_usd + b.estimated_usd,
    sessions_with_tokens: a.sessions_with_tokens + b.sessions_with_tokens,
    sessions_with_usd: a.sessions_with_usd + b.sessions_with_usd,
    sessions: a.sessions + b.sessions,
    usd_complete: a.usd_complete && b.usd_complete,
    usd_known: a.usd_known || b.usd_known,
  };
}

export const EMPTY_AGGREGATED_USAGE: AggregatedUsage = {
  input_tokens: 0,
  output_tokens: 0,
  estimated_usd: 0,
  sessions_with_tokens: 0,
  sessions_with_usd: 0,
  sessions: 0,
  usd_complete: true,
  usd_known: false,
};
