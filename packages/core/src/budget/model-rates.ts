/**
 * Model rate table + token → USD estimates (PR-18).
 * Re-exports the shared implementation so core and adapters stay in lockstep.
 */

export {
  DEFAULT_MODEL_RATES,
  DEFAULT_TIER_RATES,
  mergeModelRates,
  lookupModelRate,
  resolveRate,
  estimateUsdFromTokens,
  resolveEstimatedUsd,
  type ModelRatesTable,
} from "@lazyorch/shared";

export type { ModelRate } from "@lazyorch/shared";
