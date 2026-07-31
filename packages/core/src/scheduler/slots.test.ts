import { describe, expect, it } from "vitest";
import {
  canStartSession,
  computeSlotUsage,
  freeForWorkers,
  freeForWorkersFromSessions,
  phaseNeedsLeadReservation,
  sessionHoldsSlot,
  slotLimitsFromConfig,
} from "./slots.js";
import type { SchedulerSession, SlotLimits } from "./types.js";

function sess(
  partial: Partial<SchedulerSession> &
    Pick<SchedulerSession, "run_handle" | "role" | "state">,
): SchedulerSession {
  return {
    agent_id: partial.agent_id ?? `agt_${partial.run_handle}`,
    last_activity_ms: partial.last_activity_ms ?? 0,
    ...partial,
  };
}

const limits: SlotLimits = slotLimitsFromConfig({
  max_concurrent_agents: 8,
  max_workers: 4,
  max_reviewers: 2,
  max_qa: 2,
  reserve_slots_lead: 1,
});

describe("sessionHoldsSlot", () => {
  it("starting and running hold slots; idle/draining do not", () => {
    expect(
      sessionHoldsSlot(sess({ run_handle: "a", role: "worker", state: "running" })),
    ).toBe(true);
    expect(
      sessionHoldsSlot(
        sess({ run_handle: "b", role: "worker", state: "starting" }),
      ),
    ).toBe(true);
    expect(
      sessionHoldsSlot(sess({ run_handle: "c", role: "worker", state: "idle" })),
    ).toBe(false);
    expect(
      sessionHoldsSlot(
        sess({ run_handle: "d", role: "worker", state: "draining" }),
      ),
    ).toBe(false);
  });
});

describe("computeSlotUsage", () => {
  it("counts all roles toward slots_used; max_workers is separate", () => {
    const usage = computeSlotUsage([
      sess({ run_handle: "L", role: "lead", state: "running" }),
      sess({ run_handle: "W1", role: "worker", state: "running" }),
      sess({ run_handle: "W2", role: "worker", state: "starting" }),
      sess({ run_handle: "R", role: "reviewer", state: "running" }),
      sess({ run_handle: "Q", role: "qa", state: "running" }),
      sess({ run_handle: "idleW", role: "worker", state: "idle" }),
    ]);
    expect(usage.slots_used).toBe(5);
    expect(usage.active_workers).toBe(2);
    // idle worker still in pool
    expect(usage.pool_workers).toBe(3);
    expect(usage.active_reviewers).toBe(1);
    expect(usage.active_qa).toBe(1);
    expect(usage.active_lead).toBe(1);
  });
});

describe("freeForWorkers", () => {
  it("reserves lead slot when no lead running and phase needs reservation", () => {
    const free = freeForWorkers({
      max_concurrent_agents: 8,
      slots_used: 3,
      reserve_slots_lead: 1,
      lead_session_active: false,
      lead_reservation_needed: true,
    });
    // 8 - 3 - 1 = 4
    expect(free).toBe(4);
  });

  it("does not reserve when lead session is active", () => {
    const free = freeForWorkers({
      max_concurrent_agents: 8,
      slots_used: 3,
      reserve_slots_lead: 1,
      lead_session_active: true,
      lead_reservation_needed: true,
    });
    expect(free).toBe(5);
  });

  it("does not reserve outside lead-reserve phases", () => {
    expect(phaseNeedsLeadReservation("Implementing")).toBe(true);
    expect(phaseNeedsLeadReservation("Planning")).toBe(true);
    expect(phaseNeedsLeadReservation("Merged")).toBe(false);

    const free = freeForWorkers({
      max_concurrent_agents: 8,
      slots_used: 3,
      reserve_slots_lead: 1,
      lead_session_active: false,
      lead_reservation_needed: false,
    });
    expect(free).toBe(5);
  });

  it("never goes negative", () => {
    expect(
      freeForWorkers({
        max_concurrent_agents: 2,
        slots_used: 2,
        reserve_slots_lead: 1,
        lead_session_active: false,
        lead_reservation_needed: true,
      }),
    ).toBe(0);
  });
});

describe("canStartSession", () => {
  it("enforces max_concurrent_agents hard ceiling", () => {
    const usage = computeSlotUsage(
      Array.from({ length: 8 }, (_, i) =>
        sess({ run_handle: `w${i}`, role: "worker", state: "running" }),
      ),
    );
    expect(
      canStartSession({
        role: "worker",
        usage,
        limits,
        free_for_workers: 0,
      }),
    ).toBe(false);
  });

  it("caps workers at max_workers using pool (incl. idle)", () => {
    const usage = computeSlotUsage(
      Array.from({ length: 4 }, (_, i) =>
        sess({ run_handle: `w${i}`, role: "worker", state: "running" }),
      ),
    );
    expect(usage.active_workers).toBe(4);
    expect(usage.pool_workers).toBe(4);
    expect(
      canStartSession({
        role: "worker",
        usage,
        limits,
        free_for_workers: 3,
      }),
    ).toBe(false);
  });

  it("4 idle workers at max_workers blocks mint (pool cap)", () => {
    const usage = computeSlotUsage(
      Array.from({ length: 4 }, (_, i) =>
        sess({ run_handle: `idle${i}`, role: "worker", state: "idle" }),
      ),
    );
    expect(usage.active_workers).toBe(0);
    expect(usage.pool_workers).toBe(4);
    expect(
      canStartSession({
        role: "worker",
        usage,
        limits,
        free_for_workers: 7,
        reuse_idle: false,
      }),
    ).toBe(false);
    // Reuse idle still allowed
    expect(
      canStartSession({
        role: "worker",
        usage,
        limits,
        free_for_workers: 7,
        reuse_idle: true,
      }),
    ).toBe(true);
  });

  it("allows worker when free_for_workers ≥ 1 and under max_workers", () => {
    const usage = computeSlotUsage([
      sess({ run_handle: "w0", role: "worker", state: "running" }),
    ]);
    expect(
      canStartSession({
        role: "worker",
        usage,
        limits,
        free_for_workers: 1,
      }),
    ).toBe(true);
  });

  it("caps lead at 1", () => {
    const usage = computeSlotUsage([
      sess({ run_handle: "L", role: "lead", state: "running" }),
    ]);
    expect(canStartSession({ role: "lead", usage, limits })).toBe(false);
  });

  it("caps reviewers and qa", () => {
    const usage = computeSlotUsage([
      sess({ run_handle: "r1", role: "reviewer", state: "running" }),
      sess({ run_handle: "r2", role: "reviewer", state: "running" }),
      sess({ run_handle: "q1", role: "qa", state: "running" }),
      sess({ run_handle: "q2", role: "qa", state: "running" }),
    ]);
    expect(canStartSession({ role: "reviewer", usage, limits })).toBe(false);
    expect(canStartSession({ role: "qa", usage, limits })).toBe(false);
  });
});

describe("freeForWorkersFromSessions", () => {
  it("integrates usage + phase", () => {
    const sessions = [
      sess({ run_handle: "w", role: "worker", state: "running" }),
    ];
    const free = freeForWorkersFromSessions(sessions, "Implementing", {
      max_concurrent_agents: 8,
      reserve_slots_lead: 1,
    });
    // 8 - 1 - 1(lead reserve) = 6
    expect(free).toBe(6);
  });
});
