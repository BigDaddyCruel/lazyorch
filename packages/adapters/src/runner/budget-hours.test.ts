import { describe, expect, it } from "vitest";
import {
  BudgetHoursTracker,
  estimateUsdFromRates,
  resolveSessionUsd,
} from "./budget-hours.js";

describe("BudgetHoursTracker", () => {
  it("sums closed session wall-clock hours", () => {
    let now = 0;
    const t = new BudgetHoursTracker({
      run_id: "run_1",
      run_started_at_ms: 0,
      now: () => now,
    });
    t.recordSessionStart("a", 0);
    now = 3_600_000; // 1h
    t.recordSessionEnd("a", now);
    t.recordSessionStart("b", now);
    now = 3_600_000 + 1_800_000; // +0.5h
    t.recordSessionEnd("b", now);

    expect(t.agentHoursUsed(now)).toBeCloseTo(1.5, 5);
    expect(t.runHoursElapsed(now)).toBeCloseTo(1.5, 5);
  });

  it("counts open sessions up to now", () => {
    const now = 1_800_000; // 0.5h into run
    const t = new BudgetHoursTracker({
      run_id: "run_1",
      run_started_at_ms: 0,
      now: () => now,
    });
    t.recordSessionStart("open", 0);
    expect(t.agentHoursUsed()).toBeCloseTo(0.5, 5);
    const snap = t.snapshot();
    expect(snap.open_sessions).toBe(1);
    expect(snap.closed_sessions).toBe(0);
  });

  it("hard-stop on max_agent_hours", () => {
    const clock = { now: 0 };
    const t = new BudgetHoursTracker({
      run_id: "run_1",
      run_started_at_ms: 0,
      now: () => clock.now,
    });
    t.recordSessionStart("a", 0);
    clock.now = 3_600_000; // 1h
    t.recordSessionEnd("a", clock.now);

    const stop = t.checkHardStop({ max_agent_hours: 1, hard_stop: true });
    expect(stop.should_stop).toBe(true);
    expect(stop.reason).toBe("max_agent_hours");
  });

  it("hard-stop on max_run_hours", () => {
    const now = 7_200_000; // 2h
    const t = new BudgetHoursTracker({
      run_id: "run_1",
      run_started_at_ms: 0,
      now: () => now,
    });
    const stop = t.checkHardStop({ max_run_hours: 1.5, hard_stop: true });
    expect(stop.should_stop).toBe(true);
    expect(stop.reason).toBe("max_run_hours");
  });

  it("soft mode reports reason without should_stop", () => {
    const now = 3_600_000;
    const t = new BudgetHoursTracker({
      run_id: "run_1",
      run_started_at_ms: 0,
      now: () => now,
    });
    t.recordSessionStart("a", 0);
    t.recordSessionEnd("a", now);
    const stop = t.checkHardStop({ max_agent_hours: 0.5, hard_stop: false });
    expect(stop.should_stop).toBe(false);
    expect(stop.reason).toBe("max_agent_hours");
  });

  it("null limits never stop", () => {
    const t = new BudgetHoursTracker({ run_id: "run_1", run_started_at_ms: 0 });
    const stop = t.checkHardStop({
      max_agent_hours: null,
      max_run_hours: null,
    });
    expect(stop.should_stop).toBe(false);
    expect(stop.reason).toBe("none");
  });

  it("aggregates adapter usage and hard-stops on max_usd when known", () => {
    const t = new BudgetHoursTracker({
      run_id: "run_1",
      run_started_at_ms: 0,
    });
    t.recordSessionStart("a", 0);
    t.recordUsage("a", {
      input_tokens: 1000,
      output_tokens: 500,
      estimated_usd: 0.75,
    });
    t.recordSessionEnd("a", 1000);
    t.recordSessionStart("b", 1000);
    // custom model without adapter cost → default rate fill-in (usd complete)
    t.recordUsage(
      "b",
      { input_tokens: 1_000_000, output_tokens: 0 },
      "custom-model",
    );
    const snap = t.snapshot();
    // 0.75 adapter + 2.0 default rate for 1M in
    expect(snap.estimated_usd).toBeCloseTo(2.75, 5);
    expect(snap.usd_known).toBe(true);
    expect(snap.input_tokens).toBe(1_001_000);
    expect(snap.usd_complete).toBe(true);

    const stop = t.checkHardStop({ max_usd_per_run: 0.5, hard_stop: true });
    expect(stop.should_stop).toBe(true);
    expect(stop.reason).toBe("max_usd_per_run");
  });

  it("estimates USD from design defaults when operator rates empty", () => {
    // Stock config: model_rates {} → still merge DEFAULT_MODEL_RATES
    const t = new BudgetHoursTracker({
      run_id: "run_1",
      run_started_at_ms: 0,
      model_rates: {},
    });
    const entry = t.recordUsage(
      "s1",
      { input_tokens: 1_000_000, output_tokens: 0 },
      "claude-sonnet-4-6",
    );
    expect(entry.usd_source).toBe("rates");
    // sonnet in_per_mtok 3.0
    expect(entry.estimated_usd).toBeCloseTo(3.0, 5);
    const stop = t.checkHardStop({
      max_usd_per_run: 2,
      hard_stop: true,
      model_rates: {}, // empty must not wipe defaults
    });
    expect(stop.should_stop).toBe(true);
    expect(stop.reason).toBe("max_usd_per_run");
    expect(stop.snapshot.usd_known).toBe(true);
  });

  it("estimates USD from model_rates when adapter omits cost", () => {
    const rates = {
      m1: { in_per_mtok: 2, out_per_mtok: 4 },
    };
    const t = new BudgetHoursTracker({
      run_id: "run_1",
      run_started_at_ms: 0,
      model_rates: rates,
    });
    const entry = t.recordUsage(
      "s1",
      { input_tokens: 1_000_000, output_tokens: 500_000 },
      "m1",
    );
    expect(entry.usd_source).toBe("rates");
    // 1*2 + 0.5*4 = 4
    expect(entry.estimated_usd).toBeCloseTo(4, 5);
    const stop = t.checkHardStop({ max_usd_per_run: 3, hard_stop: true });
    expect(stop.should_stop).toBe(true);
    expect(stop.reason).toBe("max_usd_per_run");
  });

  it("falls back to default rate for unknown model with tokens", () => {
    const t = new BudgetHoursTracker({ run_id: "run_1", run_started_at_ms: 0 });
    const entry = t.recordUsage(
      "x",
      { input_tokens: 1_000_000 },
      "totally-unknown-model-xyz",
    );
    expect(entry.usd_source).toBe("rates");
    // default in_per_mtok = 2.0
    expect(entry.estimated_usd).toBeCloseTo(2.0, 5);
  });
});

describe("estimateUsdFromRates / resolveSessionUsd", () => {
  it("computes USD per million tokens", () => {
    const usd = estimateUsdFromRates(
      { input_tokens: 500_000, output_tokens: 500_000 },
      "x",
      { x: { in_per_mtok: 2, out_per_mtok: 6 } },
    );
    expect(usd).toBeCloseTo(0.5 * 2 + 0.5 * 6, 8);
  });

  it("prefers adapter cost", () => {
    const r = resolveSessionUsd(
      { estimated_usd: 0.01, input_tokens: 1_000_000 },
      "x",
      { x: { in_per_mtok: 100, out_per_mtok: 100 } },
    );
    expect(r.usd_source).toBe("adapter");
    expect(r.estimated_usd).toBe(0.01);
  });
});
