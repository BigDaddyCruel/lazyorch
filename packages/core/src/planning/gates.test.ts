import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../schema.js";
import type { Run } from "../types/run.js";
import {
  applyPlanApproveDecision,
  applyPlanDisputeDecision,
  applyPlanMaxRoundsDecision,
  createPlanApproveGate,
  createPlanDisputeGate,
  createPlanMaxRoundsGate,
  resolveGate,
  shouldOpenPlanApproveGate,
} from "./gates.js";

const FIXED = "2026-03-01T12:00:00.000Z";

function run(phase: Run["phase"] = "PlanConsensus"): Run {
  return {
    schema_version: SCHEMA_VERSION,
    id: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
    project_id: "proj",
    phase,
    idea: "gates",
    created_at: FIXED,
    updated_at: FIXED,
  };
}

describe("plan gate helpers", () => {
  it("creates plan_approve with freeze payload and timeout_at", () => {
    const gate = createPlanApproveGate({
      run_id: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
      plan_id: "plan_bbbbbbbbbbbbbbbbbbbbbbbb",
      freeze_hash: "abc",
      revision: 2,
      residual_risks: ["risk1"],
      now: () => FIXED,
      nextId: () => "gate_cccccccccccccccccccccccc",
    });
    expect(gate).toMatchObject({
      id: "gate_cccccccccccccccccccccccc",
      type: "plan_approve",
      status: "pending",
      created_at: FIXED,
      payload: {
        plan_id: "plan_bbbbbbbbbbbbbbbbbbbbbbbb",
        freeze_hash: "abc",
        revision: 2,
        residual_risks: ["risk1"],
      },
    });
    expect(gate.timeout_at).toBe("2026-03-01T13:00:00.000Z");
  });

  it("creates plan_dispute and plan_max_rounds", () => {
    const dispute = createPlanDisputeGate({
      run_id: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
      plan_id: "plan_bbbbbbbbbbbbbbbbbbbbbbbb",
      disputed_issue_ids: ["iss_1", "iss_2"],
      revision: 3,
      now: () => FIXED,
      nextId: () => "gate_dddddddddddddddddddddddd",
    });
    expect(dispute.type).toBe("plan_dispute");
    expect(dispute.payload.disputed_issue_ids).toEqual(["iss_1", "iss_2"]);

    const max = createPlanMaxRoundsGate({
      run_id: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
      plan_id: "plan_bbbbbbbbbbbbbbbbbbbbbbbb",
      rounds: 5,
      open_issues: 2,
      validation_errors: [{ code: "open_issues", message: "still open" }],
      now: () => FIXED,
      nextId: () => "gate_eeeeeeeeeeeeeeeeeeeeeeee",
    });
    expect(max.type).toBe("plan_max_rounds");
    expect(max.payload.actions).toEqual(["force_approve", "edit", "abort"]);
    expect(max.payload.open_issues).toBe(2);
  });

  it("resolveGate sets status and resolved_at", () => {
    const gate = createPlanApproveGate({
      run_id: "run_a",
      plan_id: "plan_b",
      now: () => FIXED,
      nextId: () => "gate_f",
    });
    const resolved = resolveGate(gate, "approved", {
      resolved_by: "human",
      now: () => "2026-03-01T12:30:00.000Z",
    });
    expect(resolved.status).toBe("approved");
    expect(resolved.resolved_by).toBe("human");
    expect(resolved.resolved_at).toBe("2026-03-01T12:30:00.000Z");
  });

  it("shouldOpenPlanApproveGate defaults true", () => {
    expect(shouldOpenPlanApproveGate(undefined)).toBe(true);
    expect(shouldOpenPlanApproveGate({})).toBe(true);
    expect(shouldOpenPlanApproveGate({ plan_approve: true })).toBe(true);
    expect(shouldOpenPlanApproveGate({ plan_approve: false })).toBe(false);
  });
});

describe("applyPlanApproveDecision", () => {
  it("approve → Implementing", () => {
    const gate = createPlanApproveGate({
      run_id: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
      plan_id: "plan_b",
      now: () => FIXED,
      nextId: () => "gate_g",
    });
    const { run: next, gate: g } = applyPlanApproveDecision(
      run("PlanConsensus"),
      gate,
      "approve",
      { now: () => FIXED, resolved_by: "ops" },
    );
    expect(next.phase).toBe("Implementing");
    expect(g.status).toBe("approved");
  });

  it("reject cancel → Cancelled", () => {
    const gate = createPlanApproveGate({
      run_id: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
      plan_id: "plan_b",
      now: () => FIXED,
      nextId: () => "gate_h",
    });
    const { run: next, gate: g } = applyPlanApproveDecision(
      run("PlanConsensus"),
      gate,
      "reject",
      { plan_reject_action: "cancel", now: () => FIXED },
    );
    expect(next.phase).toBe("Cancelled");
    expect(next.cancelled_reason).toBe("plan_approve rejected");
    expect(g.status).toBe("rejected");
  });

  it("reject revise → Planning", () => {
    const gate = createPlanApproveGate({
      run_id: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
      plan_id: "plan_b",
      now: () => FIXED,
      nextId: () => "gate_i",
    });
    const { run: next } = applyPlanApproveDecision(
      run("PlanConsensus"),
      gate,
      "reject",
      { plan_reject_action: "revise", now: () => FIXED },
    );
    expect(next.phase).toBe("Planning");
  });
});

describe("applyPlanDisputeDecision", () => {
  it("accept_wontfix stays Planning", () => {
    const gate = createPlanDisputeGate({
      run_id: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
      plan_id: "plan_b",
      disputed_issue_ids: ["iss_x"],
      now: () => FIXED,
      nextId: () => "gate_j",
    });
    const { run: next, gate: g, resolution } = applyPlanDisputeDecision(
      run("Planning"),
      gate,
      "accept_wontfix",
      { now: () => FIXED },
    );
    expect(next.phase).toBe("Planning");
    expect(g.status).toBe("approved");
    expect(resolution).toBe("accept_wontfix");
  });

  it("abort → Cancelled", () => {
    const gate = createPlanDisputeGate({
      run_id: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
      plan_id: "plan_b",
      disputed_issue_ids: ["iss_x"],
      now: () => FIXED,
      nextId: () => "gate_k",
    });
    const { run: next, gate: g } = applyPlanDisputeDecision(
      run("Planning"),
      gate,
      "abort",
      { now: () => FIXED },
    );
    expect(next.phase).toBe("Cancelled");
    expect(g.status).toBe("rejected");
  });
});

describe("applyPlanMaxRoundsDecision", () => {
  it("force_approve / edit approve gate; abort cancels", () => {
    const base = {
      run_id: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
      plan_id: "plan_b",
      rounds: 5,
      open_issues: 1,
      now: () => FIXED,
    };
    const force = applyPlanMaxRoundsDecision(
      run("Planning"),
      createPlanMaxRoundsGate({ ...base, nextId: () => "gate_l" }),
      "force_approve",
      { now: () => FIXED },
    );
    expect(force.gate.status).toBe("approved");
    expect(force.action).toBe("force_approve");
    expect(force.run.phase).toBe("Planning");

    const edit = applyPlanMaxRoundsDecision(
      run("Planning"),
      createPlanMaxRoundsGate({ ...base, nextId: () => "gate_m" }),
      "edit",
      { now: () => FIXED },
    );
    expect(edit.gate.status).toBe("approved");
    expect(edit.run.phase).toBe("Planning");

    const abort = applyPlanMaxRoundsDecision(
      run("Planning"),
      createPlanMaxRoundsGate({ ...base, nextId: () => "gate_n" }),
      "abort",
      { now: () => FIXED },
    );
    expect(abort.gate.status).toBe("rejected");
    expect(abort.run.phase).toBe("Cancelled");
  });
});
