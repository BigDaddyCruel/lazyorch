import { describe, expect, it } from "vitest";
import {
  canRestartLead,
  canRestartQa,
  canRestartReviewer,
  countsTowardRestartBudget,
  decideEphemeralRestart,
  defaultMaxRestartsPerHour,
  ephemeralPolicyFromConfig,
  isCleanExitStatus,
  isRestartCountableStatus,
  RestartBudgetTracker,
} from "./restart-policy.js";

describe("restart status classification", () => {
  it("counts error/timeout/stall", () => {
    expect(isRestartCountableStatus("error")).toBe(true);
    expect(isRestartCountableStatus("timeout")).toBe(true);
    expect(isRestartCountableStatus("stall")).toBe(true);
    expect(countsTowardRestartBudget("error")).toBe(true);
  });

  it("clean exits do not count", () => {
    expect(isCleanExitStatus("ok")).toBe(true);
    expect(isCleanExitStatus("cancelled")).toBe(true);
    expect(countsTowardRestartBudget("ok")).toBe(false);
    expect(countsTowardRestartBudget("cancelled")).toBe(false);
  });

  it("cancelled may count when forced", () => {
    expect(
      countsTowardRestartBudget("cancelled", { count_cancelled: true }),
    ).toBe(true);
  });
});

describe("RestartBudgetTracker", () => {
  it("tracks rolling hour and ignores clean exits", () => {
    const now = 0;
    const t = new RestartBudgetTracker({
      role: "reviewer",
      max_restarts_per_hour: 3,
      now: () => now,
    });

    expect(t.recordExit("ok").counted).toBe(false);
    expect(t.restartsLastHour()).toBe(0);
    expect(t.canRestart()).toBe(true);

    const e1 = t.recordExit("error");
    expect(e1.counted).toBe(true);
    expect(e1.within_budget).toBe(true);
    expect(e1.restarts_last_hour).toBe(1);

    t.recordExit("timeout");
    t.recordExit("stall");
    const e4 = t.recordExit("error");
    // 4th crash with max 3 → exhausted
    expect(e4.within_budget).toBe(false);
    expect(e4.should_human_intervention).toBe(true);
    expect(t.canRestart()).toBe(false);
  });

  it("prunes events outside the rolling window", () => {
    let now = 0;
    const t = new RestartBudgetTracker({
      role: "lead",
      max_restarts_per_hour: 2,
      window_ms: 3_600_000,
      now: () => now,
    });
    t.recordExit("error", { at_ms: 0 });
    t.recordExit("error", { at_ms: 1000 });
    expect(t.restartsLastHour(1000)).toBe(2);
    expect(t.canRestart(1000)).toBe(false);

    // Events at 0 and 1000; cutoff = now - 1h must be > 1000 to prune both.
    now = 3_601_001;
    expect(t.restartsLastHour(now)).toBe(0);
    expect(t.canRestart(now)).toBe(true);
  });
});

describe("role restart decisions", () => {
  it("lead restarts only with agent work pending and under cap", () => {
    expect(
      canRestartLead({
        restarts_last_hour: 1,
        max_restarts_per_hour: 3,
        agent_work_pending: true,
      }),
    ).toBe(true);
    expect(
      canRestartLead({
        restarts_last_hour: 1,
        max_restarts_per_hour: 3,
        agent_work_pending: false,
      }),
    ).toBe(false);
    expect(
      canRestartLead({
        restarts_last_hour: 3,
        max_restarts_per_hour: 3,
        agent_work_pending: true,
      }),
    ).toBe(false);
  });

  it("reviewer/qa require queue work", () => {
    expect(
      canRestartReviewer({
        restarts_last_hour: 0,
        max_restarts_per_hour: 6,
        review_queue_nonempty: true,
      }),
    ).toBe(true);
    expect(
      canRestartReviewer({
        restarts_last_hour: 0,
        max_restarts_per_hour: 6,
        review_queue_nonempty: false,
      }),
    ).toBe(false);
    expect(
      canRestartQa({
        restarts_last_hour: 5,
        max_restarts_per_hour: 6,
        qa_work_pending: true,
      }),
    ).toBe(true);
    expect(
      canRestartQa({
        restarts_last_hour: 6,
        max_restarts_per_hour: 6,
        qa_work_pending: true,
      }),
    ).toBe(false);
  });

  it("decideEphemeralRestart clean vs crash vs exhausted", () => {
    expect(
      decideEphemeralRestart({
        role: "lead",
        exit_status: "ok",
        restarts_last_hour: 0,
        max_restarts_per_hour: 3,
        work_pending: true,
      }),
    ).toMatchObject({
      counted: false,
      should_restart: false,
      reason: "clean_exit",
    });

    expect(
      decideEphemeralRestart({
        role: "reviewer",
        exit_status: "timeout",
        restarts_last_hour: 1,
        max_restarts_per_hour: 6,
        work_pending: true,
      }),
    ).toMatchObject({
      counted: true,
      should_restart: true,
      human_intervention: false,
      reason: "restart",
    });

    expect(
      decideEphemeralRestart({
        role: "qa",
        exit_status: "error",
        restarts_last_hour: 6,
        max_restarts_per_hour: 6,
        work_pending: true,
      }),
    ).toMatchObject({
      counted: true,
      should_restart: false,
      human_intervention: true,
      reason: "restart_budget_exhausted",
    });
  });

  it("ephemeralPolicyFromConfig maps operator sections", () => {
    const lead = ephemeralPolicyFromConfig("lead", {
      lead: { max_restarts_per_hour: 5 },
    });
    expect(lead.max_restarts_per_hour).toBe(5);
    expect(defaultMaxRestartsPerHour("lead")).toBe(3);
    expect(defaultMaxRestartsPerHour("reviewer")).toBe(6);
    expect(defaultMaxRestartsPerHour("qa")).toBe(6);
  });
});
