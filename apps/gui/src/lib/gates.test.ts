import { describe, expect, it } from "vitest";
import type { BoardGate, BoardRun } from "../api/types.js";
import {
  collectPendingGates,
  countPendingGates,
  countPendingGatesAcrossRuns,
  gateStatusTone,
  gatesBadgeLabel,
} from "./gates.js";

function gate(partial: Partial<BoardGate> & Pick<BoardGate, "id" | "status">): BoardGate {
  return {
    type: "plan_approve",
    run_id: "run_1",
    created_at: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("gates helpers", () => {
  it("counts pending gates", () => {
    const gates = [
      gate({ id: "g1", status: "pending" }),
      gate({ id: "g2", status: "approved" }),
      gate({ id: "g3", status: "pending" }),
    ];
    expect(countPendingGates(gates)).toBe(2);
  });

  it("aggregates across runs and collects with idea", () => {
    const runs = [
      {
        id: "r1",
        project_id: "p",
        phase: "PlanConsensus",
        idea: "Idea A",
        created_at: "t",
        tasks: [],
        agents: [],
        gates: [gate({ id: "g1", status: "pending", run_id: "r1" })],
      },
      {
        id: "r2",
        project_id: "p",
        phase: "Implementing",
        idea: "Idea B",
        created_at: "t",
        tasks: [],
        agents: [],
        gates: [
          gate({ id: "g2", status: "approved", run_id: "r2" }),
          gate({
            id: "g3",
            status: "pending",
            run_id: "r2",
            created_at: "2026-01-02T00:00:00.000Z",
          }),
        ],
      },
    ] satisfies BoardRun[];

    expect(countPendingGatesAcrossRuns(runs)).toBe(2);
    const pending = collectPendingGates(runs);
    expect(pending.map((g) => g.id)).toEqual(["g1", "g3"]);
    expect(pending[0]?.idea).toBe("Idea A");
  });

  it("badge label saturates at 99+", () => {
    expect(gatesBadgeLabel(0)).toBeNull();
    expect(gatesBadgeLabel(3)).toBe("3");
    expect(gatesBadgeLabel(100)).toBe("99+");
  });

  it("maps status tones", () => {
    expect(gateStatusTone("pending")).toBe("warn");
    expect(gateStatusTone("approved")).toBe("ok");
    expect(gateStatusTone("rejected")).toBe("err");
    expect(gateStatusTone("timed_out")).toBe("err");
  });
});
