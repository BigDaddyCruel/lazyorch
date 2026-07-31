import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_RATES,
  mergeModelRates,
  lookupModelRate,
  estimateUsdFromTokens,
  resolveEstimatedUsd,
  aggregateUsage,
  mergeAggregatedUsage,
  evaluateBudget,
  usageSnapshotFrom,
  isBudgetPressure,
  isBudgetExhausted,
} from "./index.js";

describe("model rates", () => {
  it("looks up exact and case-insensitive model ids", () => {
    expect(lookupModelRate("claude-sonnet-4-6")?.in_per_mtok).toBe(3.0);
    expect(lookupModelRate("CLAUDE-SONNET-4-6")?.out_per_mtok).toBe(15.0);
    expect(lookupModelRate("n/a")).toBeUndefined();
    expect(lookupModelRate(undefined)).toBeUndefined();
  });

  it("operator rates override defaults", () => {
    const table = mergeModelRates({
      "claude-sonnet-4-6": { in_per_mtok: 99, out_per_mtok: 100 },
    });
    expect(table["claude-sonnet-4-6"]?.in_per_mtok).toBe(99);
    expect(table["o4-mini"]?.in_per_mtok).toBe(
      DEFAULT_MODEL_RATES["o4-mini"]?.in_per_mtok,
    );
  });

  it("estimates USD from tokens + rates", () => {
    // 1M in + 1M out at sonnet rates → 3 + 15 = 18
    const usd = estimateUsdFromTokens({
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      model: "claude-sonnet-4-6",
    });
    expect(usd).toBeCloseTo(18, 5);
  });

  it("prefers adapter estimated_usd over rates", () => {
    const r = resolveEstimatedUsd({
      estimated_usd: 0.42,
      input_tokens: 1_000_000,
      model: "claude-sonnet-4-6",
    });
    expect(r.source).toBe("adapter");
    expect(r.estimated_usd).toBe(0.42);
  });

  it("falls back to rates when no adapter cost", () => {
    const r = resolveEstimatedUsd({
      input_tokens: 500_000,
      output_tokens: 0,
      model: "o4-mini",
    });
    expect(r.source).toBe("rates");
    expect(r.estimated_usd).toBeCloseTo(0.55, 5); // 0.5M * 1.1
  });
});

describe("aggregateUsage", () => {
  it("sums tokens and adapter USD", () => {
    const agg = aggregateUsage(
      [
        { input_tokens: 100, output_tokens: 50, estimated_usd: 0.01 },
        { input_tokens: 200, output_tokens: 25, estimated_usd: 0.02 },
      ],
      { estimate_missing: false },
    );
    expect(agg.input_tokens).toBe(300);
    expect(agg.output_tokens).toBe(75);
    expect(agg.estimated_usd).toBeCloseTo(0.03, 8);
    expect(agg.usd_known).toBe(true);
    expect(agg.usd_complete).toBe(true);
    expect(agg.sessions).toBe(2);
  });

  it("estimates missing USD from model_rates", () => {
    const agg = aggregateUsage(
      [
        {
          input_tokens: 1_000_000,
          output_tokens: 0,
          model: "claude-haiku-4-5",
        },
      ],
      { estimate_missing: true },
    );
    expect(agg.usd_known).toBe(true);
    expect(agg.estimated_usd).toBeCloseTo(1.0, 5); // haiku in_per_mtok 1.0
  });

  it("marks usd incomplete when estimate_missing false and no cost", () => {
    const agg2 = aggregateUsage(
      [{ input_tokens: 100, output_tokens: 0 }],
      { estimate_missing: false },
    );
    expect(agg2.usd_known).toBe(false);
    expect(agg2.usd_complete).toBe(false);
  });

  it("unknown model still estimates via default rate when estimate_missing", () => {
    const agg = aggregateUsage(
      [{ input_tokens: 1_000_000, output_tokens: 0, model: "totally-unknown-xyz" }],
      { estimate_missing: true, model_rates: {} },
    );
    expect(agg.usd_known).toBe(true);
    expect(agg.estimated_usd).toBeCloseTo(2.0, 5); // default rate
  });

  it("mergeAggregatedUsage requires both sides complete for usd_complete", () => {
    const a = aggregateUsage(
      [{ estimated_usd: 1, input_tokens: 10 }],
      { estimate_missing: false },
    );
    const b = aggregateUsage(
      [{ input_tokens: 10 }],
      { estimate_missing: false },
    );
    expect(a.usd_complete).toBe(true);
    expect(b.usd_complete).toBe(false);
    const m = mergeAggregatedUsage(a, b);
    expect(m.usd_complete).toBe(false);
    expect(m.usd_known).toBe(true);
    expect(m.estimated_usd).toBe(1);
  });
});

describe("evaluateBudget / pressure", () => {
  it("hours always exhaust when exceeded", () => {
    const ev = evaluateBudget({
      limits: { max_agent_hours: 1, hard_stop: true },
      usage: {
        agent_hours: 1.1,
        run_hours: 0.5,
        estimated_usd: 0,
        usd_known: false,
      },
    });
    expect(ev.budget_exhausted).toBe(true);
    expect(ev.exhaust_reason).toBe("max_agent_hours");
    expect(ev.should_hard_stop).toBe(true);
    expect(ev.budget_pressure).toBe(true);
  });

  it("USD exhaust only when known", () => {
    const unknown = evaluateBudget({
      limits: { max_usd_per_run: 1, hard_stop: true },
      usage: {
        agent_hours: 0,
        run_hours: 0,
        estimated_usd: 5,
        usd_known: false,
      },
    });
    expect(unknown.budget_exhausted).toBe(false);
    expect(unknown.exhaust_reason).toBe("none");

    const known = evaluateBudget({
      limits: { max_usd_per_run: 1, hard_stop: true },
      usage: {
        agent_hours: 0,
        run_hours: 0,
        estimated_usd: 1.5,
        usd_known: true,
      },
    });
    expect(known.budget_exhausted).toBe(true);
    expect(known.exhaust_reason).toBe("max_usd_per_run");
  });

  it("budget_pressure when remaining hours under threshold", () => {
    const pressure = isBudgetPressure({
      limits: { max_agent_hours: 1 },
      usage: {
        agent_hours: 0.9,
        run_hours: 0.9,
        estimated_usd: 0,
        usd_known: true,
      },
      thresholds: { budget_pressure_threshold_hours: 0.25 },
    });
    expect(pressure).toBe(true); // remaining 0.1 < 0.25
  });

  it("pressure when USD unknown and hours tight (prefer lower tiers)", () => {
    const ev = evaluateBudget({
      limits: { max_agent_hours: 1 },
      usage: {
        agent_hours: 0.9,
        run_hours: 0.9,
        estimated_usd: 0,
        usd_known: false,
      },
      thresholds: { budget_pressure_threshold_hours: 0.25 },
    });
    expect(ev.budget_pressure).toBe(true);
    expect(ev.pressure_reason).toBe("hours_tight_usd_unknown");
  });

  it("pressure on remaining USD under threshold", () => {
    const ev = evaluateBudget({
      limits: { max_usd_per_run: 10 },
      usage: {
        agent_hours: 0,
        run_hours: 0,
        estimated_usd: 9.5,
        usd_known: true,
      },
      thresholds: { budget_pressure_threshold_usd: 1 },
    });
    expect(ev.budget_pressure).toBe(true);
    expect(ev.pressure_reason).toBe("usd_remaining");
    expect(ev.remaining_usd).toBeCloseTo(0.5, 5);
  });

  it("no pressure when under thresholds", () => {
    const ev = evaluateBudget({
      limits: { max_agent_hours: 10, max_usd_per_run: 100 },
      usage: {
        agent_hours: 1,
        run_hours: 1,
        estimated_usd: 1,
        usd_known: true,
      },
      thresholds: {
        budget_pressure_threshold_hours: 0.25,
        budget_pressure_threshold_usd: 5,
      },
    });
    expect(ev.budget_pressure).toBe(false);
    expect(ev.budget_exhausted).toBe(false);
  });

  it("pressure from remaining run hours alone", () => {
    const ev = evaluateBudget({
      limits: { max_run_hours: 1 },
      usage: {
        agent_hours: 0,
        run_hours: 0.9,
        estimated_usd: 0,
        usd_known: true,
      },
      thresholds: { budget_pressure_threshold_hours: 0.25 },
    });
    expect(ev.budget_pressure).toBe(true);
    expect(ev.pressure_reason).toBe("hours_remaining");
    expect(ev.remaining_run_hours).toBeCloseTo(0.1, 5);
  });

  it("exhausted sets pressure_reason exhausted", () => {
    const ev = evaluateBudget({
      limits: { max_agent_hours: 1 },
      usage: {
        agent_hours: 2,
        run_hours: 2,
        estimated_usd: 0,
        usd_known: false,
      },
    });
    expect(ev.budget_exhausted).toBe(true);
    expect(ev.budget_pressure).toBe(true);
    expect(ev.pressure_reason).toBe("exhausted");
  });

  it("usageSnapshotFrom maps aggregated usage", () => {
    const snap = usageSnapshotFrom({
      agent_hours: 2,
      run_hours: 3,
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        estimated_usd: 0.5,
        sessions_with_tokens: 1,
        sessions_with_usd: 1,
        sessions: 1,
        usd_complete: true,
        usd_known: true,
      },
    });
    expect(snap.estimated_usd).toBe(0.5);
    expect(snap.usd_known).toBe(true);
    expect(isBudgetExhausted({
      limits: { max_agent_hours: 1 },
      usage: snap,
    })).toBe(true);
  });
});
