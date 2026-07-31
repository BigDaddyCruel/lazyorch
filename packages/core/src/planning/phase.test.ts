import { describe, expect, it } from "vitest";
import { defaultAdaptersForRouting } from "../models/defaults.js";
import { SCHEMA_VERSION } from "../schema.js";
import type { Run } from "../types/run.js";
import {
  applyPlanApproveDecision,
  completeForceApprove,
  applyPlanMaxRoundsDecision,
  openGatesAfterForceApprove,
} from "./index.js";
import { runPlanningPhase } from "./phase.js";
import { FakePlanningSession } from "./session-fakes.js";
import {
  draftTask,
  issue,
  validArtifacts,
  writeResult,
} from "./test-fixtures.js";

const FIXED = "2026-04-01T00:00:00.000Z";

function run(phase: Run["phase"] = "Inception"): Run {
  return {
    schema_version: SCHEMA_VERSION,
    id: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
    project_id: "proj",
    phase,
    idea: "wire planning to multi-adapter",
    created_at: FIXED,
    updated_at: FIXED,
  };
}

let seq = 0;
function resetIds() {
  seq = 0;
}
function nextAgentId() {
  seq += 1;
  return `agt_${String(seq).padStart(24, "a")}`;
}
function nextGateId() {
  seq += 1;
  return `gate_${String(seq).padStart(24, "b")}`;
}

describe("runPlanningPhase (E2E freeze via fake sessions)", () => {
  it("freezes with large-tier models and opens plan_approve", async () => {
    resetIds();
    const artifacts = validArtifacts();
    const session = new FakePlanningSession({
      writes: [writeResult(artifacts)],
      reviews: [{ issues: [] }],
    });

    const phase = await runPlanningPhase({
      run: run("Inception"),
      session,
      cwd: "/tmp/proj",
      now: () => FIXED,
      nextAgentId,
      nextGateId,
      plan_id: "plan_cccccccccccccccccccccccc",
      routing: { adapters: defaultAdaptersForRouting() },
    });

    expect(phase.result.status).toBe("frozen");
    if (phase.result.status !== "frozen") return;

    expect(phase.run.phase).toBe("PlanConsensus");
    expect(phase.run.plan_id).toBe("plan_cccccccccccccccccccccccc");
    expect(phase.result.freeze_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(phase.result.tasks.length).toBe(2);

    // large floors via router
    expect(phase.writer_route?.tier).toBe("large");
    expect(phase.reviewer_route?.tier).toBe("large");
    expect(phase.writer_route?.session_kind).toBe("llm");
    expect(phase.reviewer_route?.session_kind).toBe("llm");
    expect(phase.writer_route?.adapter_id).toBeTruthy();
    expect(phase.reviewer_route?.adapter_id).toBeTruthy();

    // fake session saw large-tier model choices
    const wReq = session.byRole("plan_writer")[0];
    const rReq = session.byRole("plan_reviewer")[0];
    expect(wReq?.model_tier).toBe("large");
    expect(rReq?.model_tier).toBe("large");
    expect(wReq?.adapter_id).toBe(phase.writer_route?.adapter_id);
    expect(rReq?.adapter_id).toBe(phase.reviewer_route?.adapter_id);

    // distinct agents in full mode
    expect(phase.collapsed).toBe(false);
    expect(phase.writer_agent.id).not.toBe(phase.reviewer_agent.id);
    expect(phase.writer_agent.role).toBe("plan_writer");
    expect(phase.reviewer_agent.role).toBe("plan_reviewer");

    // plan_approve gate opened
    expect(phase.gates).toHaveLength(1);
    expect(phase.gates[0]?.type).toBe("plan_approve");
    expect(phase.gates[0]?.status).toBe("pending");
    expect(phase.gates[0]?.payload.freeze_hash).toBe(phase.result.freeze_hash);

    // approve progresses to Implementing
    const approved = applyPlanApproveDecision(
      phase.run,
      phase.gates[0]!,
      "approve",
      { now: () => FIXED, resolved_by: "human" },
    );
    expect(approved.run.phase).toBe("Implementing");
    expect(approved.gate.status).toBe("approved");
  });

  it("auto-advances to Implementing when gates.plan_approve=false", async () => {
    resetIds();
    const session = new FakePlanningSession({
      writes: [writeResult()],
      reviews: [{ issues: [] }],
    });
    const phase = await runPlanningPhase({
      run: run("Planning"),
      session,
      cwd: ".",
      now: () => FIXED,
      nextAgentId,
      nextGateId,
      gates: { plan_approve: false },
      routing: { adapters: defaultAdaptersForRouting() },
    });
    expect(phase.result.status).toBe("frozen");
    expect(phase.gates).toEqual([]);
    // Design: PlanConsensus → Implementing when plan_approve is disabled
    expect(phase.run.phase).toBe("Implementing");
    expect(phase.writer_route?.tier).toBe("large");
  });

  it("opens plan_max_rounds when freeze never passes", async () => {
    resetIds();
    const bad = validArtifacts([
      draftTask("tsk_a", { acceptance: [] }), // invalid: empty acceptance
    ]);
    const session = new FakePlanningSession({
      writes: [writeResult(bad), writeResult(bad)],
      reviews: [{ issues: [] }, { issues: [] }],
    });
    const phase = await runPlanningPhase({
      run: run("Planning"),
      session,
      cwd: ".",
      now: () => FIXED,
      nextAgentId,
      nextGateId,
      consensus: { max_rounds: 1 },
      routing: { adapters: defaultAdaptersForRouting() },
    });
    expect(phase.result.status).toBe("max_rounds");
    expect(phase.run.phase).toBe("Planning");
    expect(phase.gates).toHaveLength(1);
    expect(phase.gates[0]?.type).toBe("plan_max_rounds");
    expect(phase.gates[0]?.payload.actions).toEqual([
      "force_approve",
      "edit",
      "abort",
    ]);

    // abort → Cancelled
    const aborted = applyPlanMaxRoundsDecision(
      phase.run,
      phase.gates[0]!,
      "abort",
      { now: () => FIXED },
    );
    expect(aborted.run.phase).toBe("Cancelled");
  });

  it("opens plan_dispute on high severity re-open of wontfix", async () => {
    resetIds();
    const artifacts = validArtifacts([draftTask("tsk_a")]);
    const openIss = issue({
      id: "iss_dddddddddddddddddddddddd",
      severity: "high",
      description: "Missing security section depth",
    });
    const session = new FakePlanningSession({
      writes: [
        writeResult(artifacts),
        writeResult(artifacts, [
          {
            issue_id: "iss_dddddddddddddddddddddddd",
            status: "wontfix",
            response: "out of scope",
          },
        ]),
      ],
      reviews: [
        { issues: [openIss] },
        {
          issues: [
            {
              ...openIss,
              status: "open",
              severity: "critical",
              updated_at: FIXED,
            },
          ],
        },
      ],
    });

    const phase = await runPlanningPhase({
      run: run("Planning"),
      session,
      cwd: ".",
      now: () => FIXED,
      nextAgentId,
      nextGateId,
      routing: { adapters: defaultAdaptersForRouting() },
    });

    expect(phase.result.status).toBe("dispute");
    if (phase.result.status !== "dispute") return;
    expect(phase.result.disputed_issue_ids).toContain(
      "iss_dddddddddddddddddddddddd",
    );
    expect(phase.gates).toHaveLength(1);
    expect(phase.gates[0]?.type).toBe("plan_dispute");
    expect(phase.gates[0]?.payload.disputed_issue_ids).toEqual([
      "iss_dddddddddddddddddddddddd",
    ]);
  });

  it("solo collapse shares agent id with plan_reviewer role view", async () => {
    resetIds();
    const session = new FakePlanningSession({
      writes: [writeResult()],
      reviews: [{ issues: [] }],
    });
    const phase = await runPlanningPhase({
      run: run("Planning"),
      session,
      cwd: ".",
      mode: "solo",
      collapse_writer_reviewer: true,
      now: () => FIXED,
      nextAgentId,
      nextGateId,
      routing: { adapters: defaultAdaptersForRouting() },
    });
    expect(phase.collapsed).toBe(true);
    expect(phase.writer_agent.id).toBe(phase.reviewer_agent.id);
    expect(phase.writer_agent.role).toBe("plan_writer");
    expect(phase.reviewer_agent.role).toBe("plan_reviewer");
    // solo still opens plan_approve (compensating gate)
    expect(phase.gates[0]?.type).toBe("plan_approve");
  });

  it("force_approve path freezes then opens follow-on plan_approve", async () => {
    resetIds();
    const artifacts = validArtifacts([draftTask("tsk_a")]);
    const openIss = issue({
      id: "iss_eeeeeeeeeeeeeeeeeeeeeeee",
      description: "residual risk item",
    });
    const session = new FakePlanningSession({
      writes: [writeResult(artifacts)],
      reviews: [{ issues: [openIss] }],
    });
    const phase = await runPlanningPhase({
      run: run("Planning"),
      session,
      cwd: ".",
      now: () => FIXED,
      nextAgentId,
      nextGateId,
      plan_id: "plan_ffffffffffffffffffffffff",
      consensus: { max_rounds: 1 },
      routing: { adapters: defaultAdaptersForRouting() },
    });
    expect(phase.result.status).toBe("max_rounds");
    if (phase.result.status !== "max_rounds") return;

    const decided = applyPlanMaxRoundsDecision(
      phase.run,
      phase.gates[0]!,
      "force_approve",
      { now: () => FIXED },
    );
    expect(decided.gate.status).toBe("approved");

    const frozen = completeForceApprove({
      run: decided.run,
      artifacts: phase.result.artifacts,
      issues: phase.result.plan.issues,
      plan_id: phase.result.plan.id,
      revision: phase.result.plan.revision,
      created_at: phase.result.plan.created_at,
      rounds: phase.result.rounds,
      now: () => FIXED,
    });
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) return;
    expect(frozen.run.phase).toBe("PlanConsensus");
    expect(frozen.result.plan.residual_risks?.length).toBeGreaterThan(0);
    expect(phase.writer_route?.tier).toBe("large");

    // Design: after force_approve freeze → normal plan_approve if enabled
    const followOn = openGatesAfterForceApprove(frozen.run, frozen.result, {
      now: () => FIXED,
      nextId: nextGateId,
    });
    expect(followOn.run.phase).toBe("PlanConsensus");
    expect(followOn.gates).toHaveLength(1);
    expect(followOn.gates[0]?.type).toBe("plan_approve");
    expect(followOn.gates[0]?.payload.residual_risks?.length).toBeGreaterThan(
      0,
    );

    const approved = applyPlanApproveDecision(
      followOn.run,
      followOn.gates[0]!,
      "approve",
      { now: () => FIXED },
    );
    expect(approved.run.phase).toBe("Implementing");
  });
});
