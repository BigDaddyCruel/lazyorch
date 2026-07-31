/**
 * Budget pressure + exhaustion for router tier cap and elasticity (PR-18).
 *
 * Policy (design cost policy / KD-24):
 * - Hours always enforceable (max_agent_hours / max_run_hours).
 * - USD best-effort: only hard-stop / exhaust on USD when estimated_usd is known.
 * - budget_pressure → router applies models.budget_tier_cap (when not pin_locked).
 * - When USD unknown and hours remaining under threshold → still pressure (prefer lower tiers).
 */

import type { AggregatedUsage } from "./usage.js";

export interface BudgetLimitsView {
  max_usd_per_run?: number | null;
  max_agent_hours?: number | null;
  max_run_hours?: number | null;
  hard_stop?: boolean;
}

export interface BudgetPressureThresholds {
  /** Remaining USD under which pressure applies; null = never from USD. */
  budget_pressure_threshold_usd?: number | null;
  /** Remaining agent-hours under which pressure applies; null = never from hours. */
  budget_pressure_threshold_hours?: number | null;
}

export interface BudgetUsageSnapshot {
  agent_hours: number;
  run_hours: number;
  /** Best-effort cumulative estimated USD. */
  estimated_usd: number;
  /** True when at least some USD is known (adapter or rates). */
  usd_known: boolean;
  /** True when every token-using session contributed USD. */
  usd_complete?: boolean;
}

export type BudgetExhaustReason =
  | "max_agent_hours"
  | "max_run_hours"
  | "max_usd_per_run"
  | "none";

export type BudgetPressureReason =
  | "hours_remaining"
  | "usd_remaining"
  | "hours_tight_usd_unknown"
  | "exhausted"
  | "none";

export interface BudgetEvaluation {
  /** Soft signal: router should apply budget_tier_cap. */
  budget_pressure: boolean;
  pressure_reason: BudgetPressureReason;
  /**
   * Hard signal: elasticity desired=0; runner should hard-stop when hard_stop.
   * Hours always; USD only when known.
   */
  budget_exhausted: boolean;
  exhaust_reason: BudgetExhaustReason;
  /** When hard_stop is true (default) and exhausted, callers cancel sessions. */
  should_hard_stop: boolean;
  hard_stop: boolean;
  remaining_agent_hours: number | null;
  remaining_run_hours: number | null;
  remaining_usd: number | null;
  snapshot: BudgetUsageSnapshot;
  message: string;
}

const DEFAULT_HOURS_THRESHOLD = 0.25;

/**
 * Evaluate budget pressure + exhaustion from current usage vs limits.
 *
 * Hours: always considered when limits set.
 * USD: only exhaust when usd_known and max_usd_per_run set and exceeded.
 * Pressure: remaining under threshold (USD if known; hours always when set).
 */
export function evaluateBudget(params: {
  limits: BudgetLimitsView;
  usage: BudgetUsageSnapshot;
  thresholds?: BudgetPressureThresholds;
}): BudgetEvaluation {
  const { limits, usage } = params;
  const thresholds = params.thresholds ?? {};
  const hard_stop = limits.hard_stop !== false;

  let exhaust_reason: BudgetExhaustReason = "none";
  let message = "within budget";

  // Hours always enforceable
  const maxAgent = limits.max_agent_hours;
  if (
    maxAgent !== undefined &&
    maxAgent !== null &&
    usage.agent_hours >= maxAgent
  ) {
    exhaust_reason = "max_agent_hours";
    message = `agent hours ${usage.agent_hours.toFixed(4)}h >= max_agent_hours ${maxAgent}`;
  }

  const maxRun = limits.max_run_hours;
  if (
    exhaust_reason === "none" &&
    maxRun !== undefined &&
    maxRun !== null &&
    usage.run_hours >= maxRun
  ) {
    exhaust_reason = "max_run_hours";
    message = `run hours ${usage.run_hours.toFixed(4)}h >= max_run_hours ${maxRun}`;
  }

  // USD best-effort: only when known
  const maxUsd = limits.max_usd_per_run;
  if (
    exhaust_reason === "none" &&
    maxUsd !== undefined &&
    maxUsd !== null &&
    usage.usd_known &&
    usage.estimated_usd >= maxUsd
  ) {
    exhaust_reason = "max_usd_per_run";
    message = `estimated_usd ${usage.estimated_usd.toFixed(4)} >= max_usd_per_run ${maxUsd}`;
  }

  const budget_exhausted = exhaust_reason !== "none";
  const should_hard_stop = budget_exhausted && hard_stop;

  const remaining_agent_hours =
    maxAgent !== undefined && maxAgent !== null
      ? Math.max(0, maxAgent - usage.agent_hours)
      : null;
  const remaining_run_hours =
    maxRun !== undefined && maxRun !== null
      ? Math.max(0, maxRun - usage.run_hours)
      : null;
  const remaining_usd =
    maxUsd !== undefined && maxUsd !== null && usage.usd_known
      ? Math.max(0, maxUsd - usage.estimated_usd)
      : null;

  const pressure = computePressure({
    remaining_agent_hours,
    remaining_run_hours,
    remaining_usd,
    usd_known: usage.usd_known,
    thresholds,
    exhausted: budget_exhausted,
  });

  return {
    budget_pressure: pressure.budget_pressure,
    pressure_reason: pressure.pressure_reason,
    budget_exhausted,
    exhaust_reason,
    should_hard_stop,
    hard_stop,
    remaining_agent_hours,
    remaining_run_hours,
    remaining_usd,
    snapshot: usage,
    message: budget_exhausted ? message : pressure.message,
  };
}

function computePressure(input: {
  remaining_agent_hours: number | null;
  remaining_run_hours: number | null;
  remaining_usd: number | null;
  usd_known: boolean;
  thresholds: BudgetPressureThresholds;
  exhausted: boolean;
}): {
  budget_pressure: boolean;
  pressure_reason: BudgetPressureReason;
  message: string;
} {
  if (input.exhausted) {
    return {
      budget_pressure: true,
      pressure_reason: "exhausted",
      message: "budget exhausted",
    };
  }

  const usdThresh =
    input.thresholds.budget_pressure_threshold_usd === undefined
      ? null
      : input.thresholds.budget_pressure_threshold_usd;
  const hoursThresh =
    input.thresholds.budget_pressure_threshold_hours === undefined
      ? DEFAULT_HOURS_THRESHOLD
      : input.thresholds.budget_pressure_threshold_hours;

  // USD remaining under threshold (only when known)
  if (
    usdThresh !== null &&
    input.remaining_usd !== null &&
    input.usd_known &&
    input.remaining_usd < usdThresh
  ) {
    return {
      budget_pressure: true,
      pressure_reason: "usd_remaining",
      message: `remaining_usd ${input.remaining_usd.toFixed(4)} < threshold ${usdThresh}`,
    };
  }

  // Agent-hours remaining under threshold
  const agentTight =
    hoursThresh !== null &&
    input.remaining_agent_hours !== null &&
    input.remaining_agent_hours < hoursThresh;

  // Run wall-clock remaining under same hours threshold (Issue 4)
  const runTight =
    hoursThresh !== null &&
    input.remaining_run_hours !== null &&
    input.remaining_run_hours < hoursThresh;

  if (agentTight || runTight) {
    const remaining = agentTight
      ? (input.remaining_agent_hours as number)
      : (input.remaining_run_hours as number);
    const kind = agentTight ? "agent" : "run";
    // Prefer lower tiers when USD unknown and hours tight (design)
    if (!input.usd_known) {
      return {
        budget_pressure: true,
        pressure_reason: "hours_tight_usd_unknown",
        message: `remaining_${kind}_hours ${remaining.toFixed(4)} < threshold ${hoursThresh} (usd unknown)`,
      };
    }
    return {
      budget_pressure: true,
      pressure_reason: "hours_remaining",
      message: `remaining_${kind}_hours ${remaining.toFixed(4)} < threshold ${hoursThresh}`,
    };
  }

  return {
    budget_pressure: false,
    pressure_reason: "none",
    message: "within budget",
  };
}

/**
 * Build BudgetUsageSnapshot from hours tracker fields + aggregated usage.
 */
export function usageSnapshotFrom(params: {
  agent_hours: number;
  run_hours: number;
  usage?: AggregatedUsage | null;
}): BudgetUsageSnapshot {
  const u = params.usage;
  return {
    agent_hours: params.agent_hours,
    run_hours: params.run_hours,
    estimated_usd: u?.estimated_usd ?? 0,
    usd_known: u?.usd_known ?? false,
    usd_complete: u?.usd_complete ?? true,
  };
}

/**
 * Router-facing boolean: should routeModel receive budget_pressure?
 * Convenience over evaluateBudget when only the flag is needed.
 */
export function isBudgetPressure(params: {
  limits: BudgetLimitsView;
  usage: BudgetUsageSnapshot;
  thresholds?: BudgetPressureThresholds;
}): boolean {
  return evaluateBudget(params).budget_pressure;
}

/** Elasticity-facing: budget_exhausted forces desired workers = 0. */
export function isBudgetExhausted(params: {
  limits: BudgetLimitsView;
  usage: BudgetUsageSnapshot;
  thresholds?: BudgetPressureThresholds;
}): boolean {
  return evaluateBudget(params).budget_exhausted;
}
