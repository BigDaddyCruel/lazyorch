/**
 * Full budget tracker (PR-07 hours stub → PR-18 USD + aggregation).
 *
 * - Hours always enforceable (max_agent_hours / max_run_hours).
 * - USD best-effort: hard-stop only when estimated_usd is known and
 *   max_usd_per_run is set and exceeded.
 * - model_rates used to estimate USD when adapters report tokens only.
 */

import type { ModelRate } from "@lazyorch/shared";
import type { Usage } from "../types.js";

export interface BudgetHoursLimits {
  max_agent_hours?: number | null;
  max_run_hours?: number | null;
  max_usd_per_run?: number | null;
  hard_stop?: boolean;
  /** Operator model id → {in_per_mtok, out_per_mtok} for token→USD. */
  model_rates?: Readonly<Record<string, ModelRate>>;
}

/** @deprecated Prefer BudgetHoursLimits (includes USD). */
export type BudgetLimits = BudgetHoursLimits;

export interface SessionHoursEntry {
  run_handle: string;
  started_at_ms: number;
  ended_at_ms?: number;
  /** Open session still running when ended_at_ms is unset. */
}

export interface SessionUsageEntry {
  run_handle: string;
  input_tokens: number;
  output_tokens: number;
  /** Best-effort USD (adapter or rates); undefined if unknown. */
  estimated_usd?: number;
  model?: string;
  usd_source?: "adapter" | "rates" | "none";
}

export interface BudgetHoursSnapshot {
  run_id: string;
  run_started_at_ms: number;
  /** Sum of closed sessions + currently open sessions (wall clock). */
  agent_hours: number;
  /** Wall clock since run start. */
  run_hours: number;
  open_sessions: number;
  closed_sessions: number;
  /** Best-effort cumulative estimated USD (0 when none known). */
  estimated_usd: number;
  input_tokens: number;
  output_tokens: number;
  /** True when at least one session contributed known USD. */
  usd_known: boolean;
  /** True when every token-using session has USD. */
  usd_complete: boolean;
  sessions_with_usage: number;
}

export type BudgetStopReason =
  | "max_agent_hours"
  | "max_run_hours"
  | "max_usd_per_run"
  | "none";

export interface BudgetHardStopResult {
  should_stop: boolean;
  reason: BudgetStopReason;
  hard_stop: boolean;
  snapshot: BudgetHoursSnapshot;
  message: string;
}

export interface BudgetHoursTrackerOptions {
  run_id: string;
  run_started_at_ms?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Default model rates for token→USD when recording usage. */
  model_rates?: Readonly<Record<string, ModelRate>>;
}

/**
 * Estimate USD from tokens + rates (USD per million tokens).
 * Returns undefined when rate missing or no tokens.
 */
export function estimateUsdFromRates(
  usage: { input_tokens?: number; output_tokens?: number },
  model: string | undefined,
  rates: Readonly<Record<string, ModelRate>> | undefined,
): number | undefined {
  if (!rates || !model || model === "n/a") return undefined;
  const rate =
    rates[model] ??
    Object.entries(rates).find(
      ([k]) => k.toLowerCase() === model.toLowerCase(),
    )?.[1];
  if (!rate) return undefined;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  if (input <= 0 && output <= 0) return undefined;
  return (
    (input / 1_000_000) * rate.in_per_mtok +
    (output / 1_000_000) * rate.out_per_mtok
  );
}

/**
 * Resolve best-effort USD for a session usage blob.
 * Prefer adapter estimated_usd; else model_rates.
 */
export function resolveSessionUsd(
  usage: Usage | undefined,
  model: string | undefined,
  rates: Readonly<Record<string, ModelRate>> | undefined,
): { estimated_usd?: number; usd_source: "adapter" | "rates" | "none" } {
  if (
    usage?.estimated_usd !== undefined &&
    Number.isFinite(usage.estimated_usd) &&
    usage.estimated_usd >= 0
  ) {
    return { estimated_usd: usage.estimated_usd, usd_source: "adapter" };
  }
  const tokenArgs: { input_tokens?: number; output_tokens?: number } = {};
  if (usage?.input_tokens !== undefined) {
    tokenArgs.input_tokens = usage.input_tokens;
  }
  if (usage?.output_tokens !== undefined) {
    tokenArgs.output_tokens = usage.output_tokens;
  }
  const fromRates = estimateUsdFromRates(tokenArgs, model, rates);
  if (fromRates !== undefined) {
    return { estimated_usd: fromRates, usd_source: "rates" };
  }
  return { usd_source: "none" };
}

/**
 * In-memory (per run) tracker of agent session hours + usage/cost.
 * Persist/restore is the scheduler's concern; this is pure accounting.
 */
export class BudgetHoursTracker {
  readonly run_id: string;
  readonly run_started_at_ms: number;
  private readonly now: () => number;
  private readonly sessions = new Map<string, SessionHoursEntry>();
  private readonly usageByHandle = new Map<string, SessionUsageEntry>();
  private model_rates: Readonly<Record<string, ModelRate>>;

  constructor(options: BudgetHoursTrackerOptions) {
    this.run_id = options.run_id;
    this.now = options.now ?? Date.now;
    this.run_started_at_ms = options.run_started_at_ms ?? this.now();
    this.model_rates = options.model_rates ?? {};
  }

  /** Update rates used for subsequent usage estimates. */
  setModelRates(rates: Readonly<Record<string, ModelRate>>): void {
    this.model_rates = rates;
  }

  recordSessionStart(runHandle: string, startedAtMs?: number): void {
    const started_at_ms = startedAtMs ?? this.now();
    this.sessions.set(runHandle, {
      run_handle: runHandle,
      started_at_ms,
    });
  }

  recordSessionEnd(runHandle: string, endedAtMs?: number): void {
    const existing = this.sessions.get(runHandle);
    const ended_at_ms = endedAtMs ?? this.now();
    if (!existing) {
      // Session we never saw start — still record zero-duration close.
      this.sessions.set(runHandle, {
        run_handle: runHandle,
        started_at_ms: ended_at_ms,
        ended_at_ms,
      });
      return;
    }
    this.sessions.set(runHandle, {
      ...existing,
      ended_at_ms,
    });
  }

  /**
   * Record usage from an adapter SessionResult (or partial).
   * Call on session end (or mid-session updates). Idempotent per handle
   * (last write wins).
   */
  recordUsage(
    runHandle: string,
    usage: Usage | undefined,
    model?: string,
  ): SessionUsageEntry {
    const rates = this.model_rates;
    const resolved = resolveSessionUsd(usage, model, rates);
    const entry: SessionUsageEntry = {
      run_handle: runHandle,
      input_tokens: usage?.input_tokens ?? 0,
      output_tokens: usage?.output_tokens ?? 0,
      usd_source: resolved.usd_source,
    };
    if (resolved.estimated_usd !== undefined) {
      entry.estimated_usd = resolved.estimated_usd;
    }
    if (model !== undefined) {
      entry.model = model;
    }
    this.usageByHandle.set(runHandle, entry);
    return entry;
  }

  /** All recorded usage entries (for aggregation / tests). */
  listUsage(): SessionUsageEntry[] {
    return [...this.usageByHandle.values()];
  }

  /** Elapsed agent-hours (sum of session wall times, open sessions counted to now). */
  agentHoursUsed(atMs?: number): number {
    const t = atMs ?? this.now();
    let ms = 0;
    for (const s of this.sessions.values()) {
      const end = s.ended_at_ms ?? t;
      ms += Math.max(0, end - s.started_at_ms);
    }
    return ms / 3_600_000;
  }

  runHoursElapsed(atMs?: number): number {
    const t = atMs ?? this.now();
    return Math.max(0, t - this.run_started_at_ms) / 3_600_000;
  }

  private aggregateUsage(): {
    estimated_usd: number;
    input_tokens: number;
    output_tokens: number;
    usd_known: boolean;
    usd_complete: boolean;
    sessions_with_usage: number;
  } {
    let estimated_usd = 0;
    let input_tokens = 0;
    let output_tokens = 0;
    let withUsd = 0;
    let withTokensNoUsd = 0;
    let withAny = 0;

    for (const u of this.usageByHandle.values()) {
      const hasTokens = u.input_tokens > 0 || u.output_tokens > 0;
      const hasUsd = u.estimated_usd !== undefined;
      if (hasTokens || hasUsd) withAny += 1;
      input_tokens += u.input_tokens;
      output_tokens += u.output_tokens;
      if (hasUsd) {
        estimated_usd += u.estimated_usd as number;
        withUsd += 1;
      } else if (hasTokens) {
        withTokensNoUsd += 1;
      }
    }

    return {
      estimated_usd,
      input_tokens,
      output_tokens,
      usd_known: withUsd > 0,
      usd_complete: withTokensNoUsd === 0,
      sessions_with_usage: withAny,
    };
  }

  snapshot(atMs?: number): BudgetHoursSnapshot {
    const t = atMs ?? this.now();
    let open = 0;
    let closed = 0;
    for (const s of this.sessions.values()) {
      if (s.ended_at_ms === undefined) open += 1;
      else closed += 1;
    }
    const usage = this.aggregateUsage();
    return {
      run_id: this.run_id,
      run_started_at_ms: this.run_started_at_ms,
      agent_hours: this.agentHoursUsed(t),
      run_hours: this.runHoursElapsed(t),
      open_sessions: open,
      closed_sessions: closed,
      estimated_usd: usage.estimated_usd,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      usd_known: usage.usd_known,
      usd_complete: usage.usd_complete,
      sessions_with_usage: usage.sessions_with_usage,
    };
  }

  /**
   * Hard-stop check.
   * Hours always when limits set; USD only when usd_known and max_usd set.
   * When hard_stop is true (default) and a limit is exceeded, should_stop is true.
   */
  checkHardStop(
    limits: BudgetHoursLimits,
    atMs?: number,
  ): BudgetHardStopResult {
    // Prefer rates from limits when provided for subsequent estimate consistency
    if (limits.model_rates) {
      this.model_rates = limits.model_rates;
    }

    const snapshot = this.snapshot(atMs);
    const hard_stop = limits.hard_stop !== false;

    const maxAgent = limits.max_agent_hours;
    if (
      maxAgent !== undefined &&
      maxAgent !== null &&
      snapshot.agent_hours >= maxAgent
    ) {
      return {
        should_stop: hard_stop,
        reason: "max_agent_hours",
        hard_stop,
        snapshot,
        message: `agent hours ${snapshot.agent_hours.toFixed(4)}h >= max_agent_hours ${maxAgent}`,
      };
    }

    const maxRun = limits.max_run_hours;
    if (
      maxRun !== undefined &&
      maxRun !== null &&
      snapshot.run_hours >= maxRun
    ) {
      return {
        should_stop: hard_stop,
        reason: "max_run_hours",
        hard_stop,
        snapshot,
        message: `run hours ${snapshot.run_hours.toFixed(4)}h >= max_run_hours ${maxRun}`,
      };
    }

    // USD best-effort: only when known
    const maxUsd = limits.max_usd_per_run;
    if (
      maxUsd !== undefined &&
      maxUsd !== null &&
      snapshot.usd_known &&
      snapshot.estimated_usd >= maxUsd
    ) {
      return {
        should_stop: hard_stop,
        reason: "max_usd_per_run",
        hard_stop,
        snapshot,
        message: `estimated_usd ${snapshot.estimated_usd.toFixed(4)} >= max_usd_per_run ${maxUsd}`,
      };
    }

    return {
      should_stop: false,
      reason: "none",
      hard_stop,
      snapshot,
      message: "within budget hours",
    };
  }
}

/** Alias used by PR-18 call sites / docs. */
export { BudgetHoursTracker as BudgetTracker };
