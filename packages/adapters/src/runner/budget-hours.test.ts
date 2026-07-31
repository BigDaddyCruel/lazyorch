import { describe, expect, it } from "vitest";
import { BudgetHoursTracker } from "./budget-hours.js";

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
});
