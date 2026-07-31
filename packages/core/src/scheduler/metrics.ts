/**
 * Scheduler + router observability metrics (design § metrics).
 *
 * Gauges: scheduler.desired_workers, active_workers, slots_used
 * Counters: scheduler.scale_events, router.*, adapter.session_starts
 *
 * Pure in-memory counters for unit tests; daemon can wrap/export later.
 */

import type { ModelTier } from "../types/model-tier.js";
import type { RouteResult } from "../models/types.js";
import type { ScaleActionKind } from "./types.js";

export interface SchedulerGauges {
  "scheduler.desired_workers": number;
  "scheduler.active_workers": number;
  "scheduler.slots_used": number;
}

export interface SchedulerCounters {
  "scheduler.scale_events": number;
  "router.tier_selected": number;
  "router.complexity_score_sum": number;
  "router.complexity_score_count": number;
  "router.escalations": number;
  "router.floor_violations": number;
}

/** Labeled counter key: adapter.session_starts{adapter,model,tier} */
export type SessionStartLabel = {
  adapter: string;
  model: string;
  tier: string;
};

function sessionStartKey(label: SessionStartLabel): string {
  return `adapter.session_starts{adapter=${label.adapter},model=${label.model},tier=${label.tier}}`;
}

export class SchedulerMetrics {
  private gauges: SchedulerGauges = {
    "scheduler.desired_workers": 0,
    "scheduler.active_workers": 0,
    "scheduler.slots_used": 0,
  };

  private counters: SchedulerCounters = {
    "scheduler.scale_events": 0,
    "router.tier_selected": 0,
    "router.complexity_score_sum": 0,
    "router.complexity_score_count": 0,
    "router.escalations": 0,
    "router.floor_violations": 0,
  };

  /** adapter.session_starts labeled series */
  private sessionStarts = new Map<string, number>();

  /** Tier histogram: tier → count */
  private tierSelected = new Map<string, number>();

  setGauges( partial: Partial<SchedulerGauges>): void {
    this.gauges = { ...this.gauges, ...partial };
  }

  recordScaleEvent(action: ScaleActionKind): void {
    if (action === "none") return;
    this.counters["scheduler.scale_events"] += 1;
  }

  /**
   * Record a model route at session assign time.
   * Metrics include tier/adapter (PR-12 requirement).
   */
  recordRoute(result: RouteResult): void {
    const tierKey =
      result.tier === null || result.tier === undefined
        ? "null"
        : result.tier;
    this.counters["router.tier_selected"] += 1;
    this.tierSelected.set(
      tierKey,
      (this.tierSelected.get(tierKey) ?? 0) + 1,
    );

    if (result.score !== undefined) {
      this.counters["router.complexity_score_sum"] += result.score;
      this.counters["router.complexity_score_count"] += 1;
    }
    if (result.reason === "escalate") {
      this.counters["router.escalations"] += 1;
    }
    if (result.floor_violated) {
      this.counters["router.floor_violations"] += 1;
    }

    this.recordSessionStart({
      adapter: result.adapter_id,
      model: result.model,
      tier: tierKey,
    });
  }

  recordSessionStart(label: SessionStartLabel): void {
    const k = sessionStartKey(label);
    this.sessionStarts.set(k, (this.sessionStarts.get(k) ?? 0) + 1);
  }

  gauge(name: keyof SchedulerGauges): number {
    return this.gauges[name];
  }

  counter(name: keyof SchedulerCounters): number {
    return this.counters[name];
  }

  /** Mean complexity score, or undefined if none recorded. */
  meanComplexityScore(): number | undefined {
    const n = this.counters["router.complexity_score_count"];
    if (n === 0) return undefined;
    return this.counters["router.complexity_score_sum"] / n;
  }

  sessionStartCount(label: SessionStartLabel): number {
    return this.sessionStarts.get(sessionStartKey(label)) ?? 0;
  }

  tierCount(tier: ModelTier | "null" | string): number {
    return this.tierSelected.get(tier) ?? 0;
  }

  /** Snapshot for tests / export. */
  snapshot(): {
    gauges: SchedulerGauges;
    counters: SchedulerCounters;
    session_starts: Record<string, number>;
    tiers: Record<string, number>;
  } {
    return {
      gauges: { ...this.gauges },
      counters: { ...this.counters },
      session_starts: Object.fromEntries(this.sessionStarts),
      tiers: Object.fromEntries(this.tierSelected),
    };
  }

  reset(): void {
    this.gauges = {
      "scheduler.desired_workers": 0,
      "scheduler.active_workers": 0,
      "scheduler.slots_used": 0,
    };
    this.counters = {
      "scheduler.scale_events": 0,
      "router.tier_selected": 0,
      "router.complexity_score_sum": 0,
      "router.complexity_score_count": 0,
      "router.escalations": 0,
      "router.floor_violations": 0,
    };
    this.sessionStarts.clear();
    this.tierSelected.clear();
  }
}
