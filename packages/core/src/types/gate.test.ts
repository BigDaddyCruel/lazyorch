import { describe, expect, it } from "vitest";
import {
  GATE_STATUSES,
  GATE_TYPES,
  isGateStatus,
  isGateType,
  type Gate,
} from "./gate.js";

describe("Gate types", () => {
  it("recognizes every GateType", () => {
    for (const t of GATE_TYPES) {
      expect(isGateType(t)).toBe(true);
    }
  });

  it("rejects unknown gate types", () => {
    expect(isGateType("plan_approve_extra")).toBe(false);
    expect(isGateType("")).toBe(false);
    expect(isGateType(null)).toBe(false);
    expect(isGateType(1)).toBe(false);
  });

  it("recognizes every GateStatus", () => {
    for (const s of GATE_STATUSES) {
      expect(isGateStatus(s)).toBe(true);
    }
    expect(isGateStatus("pending_extra")).toBe(false);
  });

  it("includes the design inventory of gate types", () => {
    expect(GATE_TYPES).toEqual([
      "plan_approve",
      "plan_dispute",
      "plan_max_rounds",
      "task_approve",
      "merge",
      "destructive_git",
      "budget_override",
      "human_intervention",
    ]);
  });

  it("Gate shape is constructible", () => {
    const gate: Gate = {
      id: "gate_abc",
      type: "plan_approve",
      run_id: "run_1",
      status: "pending",
      created_at: "2026-01-01T00:00:00.000Z",
      payload: { summary: "Approve plan r3" },
    };
    expect(isGateType(gate.type)).toBe(true);
    expect(isGateStatus(gate.status)).toBe(true);
  });
});
