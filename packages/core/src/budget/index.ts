/**
 * Budget / cost helpers (PR-18).
 * Pure module: model rates, usage aggregation, pressure + exhaustion.
 * Hours always enforceable; USD best-effort.
 */

export {
  DEFAULT_MODEL_RATES,
  DEFAULT_TIER_RATES,
  mergeModelRates,
  lookupModelRate,
  resolveRate,
  estimateUsdFromTokens,
  resolveEstimatedUsd,
  type ModelRate,
  type ModelRatesTable,
} from "./model-rates.js";

export {
  aggregateUsage,
  mergeAggregatedUsage,
  EMPTY_AGGREGATED_USAGE,
  type SessionUsage,
  type AggregatedUsage,
  type AggregateUsageOptions,
} from "./usage.js";

export {
  evaluateBudget,
  usageSnapshotFrom,
  isBudgetPressure,
  isBudgetExhausted,
  type BudgetLimitsView,
  type BudgetPressureThresholds,
  type BudgetUsageSnapshot,
  type BudgetExhaustReason,
  type BudgetPressureReason,
  type BudgetEvaluation,
} from "./pressure.js";
