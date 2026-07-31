/**
 * E2E vertical smoke (fakes only): planning freeze → plan_approve → implement ticks.
 *
 * Not a full stack E2E (no daemon HTTP, CLI, or live adapters). Complements
 * package unit tests by stitching planning + implementing in one path.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_REQUIRED_SECTIONS,
  SCHEMA_VERSION,
  FakeForgeIntegrate,
  FakeIntegrationMutex,
  FakePlanningSession,
  FakeReviewerSession,
  FakeScopeLockManager,
  FakeWorktreePort,
  FakeWorkerSession,
  applyPlanApproveDecision,
  defaultAdaptersForRouting,
  emptySchedulerRuntime,
  implementingTick,
  type Run,
  type SchedulerRuntimeState,
  type Task,
  runPlanningPhase,
} from "@lazyorch/core";

const FIXED = "2026-07-31T12:00:00.000Z";
/** Prefixed hex-like ids (isPrefixedId-safe shape). */
const RUN_ID = "run_e2e00000000000000000001";
const PLAN_ID = "plan_e2e00000000000000000001";

/**
 * DESIGN.md whose headings cover {@link DEFAULT_REQUIRED_SECTIONS}
 * (substring match). Keeps smoke in sync if required sections grow.
 */
function designMdFromRequiredSections(): string {
  const lines: string[] = [];
  for (const section of DEFAULT_REQUIRED_SECTIONS) {
    if (section === "Title") {
      lines.push("# Title & metadata", "", "E2E smoke plan.", "");
      continue;
    }
    if (section === "Key Decisions") {
      lines.push(
        `## ${section}`,
        "",
        "| KD | Decision |",
        "|----|----------|",
        "| 1  | Fake ports for E2E |",
        "",
      );
      continue;
    }
    if (section === "PR Plan") {
      lines.push(`## ${section} / Task DAG`, "", "See TASK_DAG.json.", "");
      continue;
    }
    lines.push(`## ${section}`, "", `E2E smoke: ${section}.`, "");
  }
  return lines.join("\n");
}

function smokeArtifacts() {
  return {
    design_md: designMdFromRequiredSections(),
    task_dag: {
      tasks: [
        {
          id: "tsk_smoke",
          title: "Smoke implement",
          description: "Single-task implement path for E2E",
          depends_on: [] as string[],
          role_affinity: ["worker"],
          scope: ["src/smoke/**"],
          acceptance: ["smoke tests pass"],
          review_criteria: ["typecheck"],
        },
      ],
    },
    pr_plan_md: "# PR Plan\n\n- tsk_smoke: implement\n",
  };
}

function baseRun(phase: Run["phase"] = "Inception"): Run {
  return {
    schema_version: SCHEMA_VERSION,
    id: RUN_ID,
    project_id: "proj_e2e",
    phase,
    idea: "e2e smoke planning freeze + implement",
    created_at: FIXED,
    updated_at: FIXED,
  };
}

let agentSeq = 0;
let gateSeq = 0;
function nextAgentId(): string {
  agentSeq += 1;
  return `agt_${String(agentSeq).padStart(24, "a")}`;
}
function nextGateId(): string {
  gateSeq += 1;
  return `gate_${String(gateSeq).padStart(24, "b")}`;
}

describe("E2E smoke: planning freeze + implement tick (fakes)", () => {
  it("freezes plan, approves gate, drives task to done without live LLM", async () => {
    agentSeq = 0;
    gateSeq = 0;
    const artifacts = smokeArtifacts();
    const session = new FakePlanningSession({
      writes: [{ artifacts }],
      reviews: [{ issues: [] }],
    });

    // 1) Planning freeze (large-tier routes; scripted writer/reviewer)
    const planning = await runPlanningPhase({
      run: baseRun("Inception"),
      session,
      cwd: "/tmp/lazyorch-e2e-smoke",
      now: () => FIXED,
      nextAgentId,
      nextGateId,
      plan_id: PLAN_ID,
      routing: { adapters: defaultAdaptersForRouting() },
    });

    expect(planning.result.status).toBe("frozen");
    if (planning.result.status !== "frozen") return;

    expect(planning.result.freeze_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(planning.result.tasks).toHaveLength(1);
    expect(planning.result.tasks[0]?.id).toBe("tsk_smoke");
    expect(planning.result.tasks[0]?.status).toBe("todo");
    expect(planning.run.phase).toBe("PlanConsensus");
    expect(planning.run.plan_id).toBe(PLAN_ID);
    expect(planning.writer_route?.tier).toBe("large");
    expect(planning.reviewer_route?.tier).toBe("large");
    expect(planning.gates).toHaveLength(1);
    expect(planning.gates[0]?.type).toBe("plan_approve");
    expect(planning.gates[0]?.payload.freeze_hash).toBe(
      planning.result.freeze_hash,
    );

    // Fake session saw adapter/model routing (not live process)
    expect(session.requests.length).toBeGreaterThanOrEqual(2);
    expect(session.byRole("plan_writer")[0]?.adapter_id).toBeTruthy();
    expect(session.byRole("plan_reviewer")[0]?.adapter_id).toBeTruthy();

    // 2) Human plan_approve → Implementing
    const approved = applyPlanApproveDecision(
      planning.run,
      planning.gates[0]!,
      "approve",
      { now: () => FIXED, resolved_by: "human" },
    );
    expect(approved.run.phase).toBe("Implementing");
    expect(approved.gate.status).toBe("approved");

    // 3) Implementing ticks with fake worker/reviewer/forge
    const locks = new FakeScopeLockManager();
    const mutex = new FakeIntegrationMutex();
    const forge = new FakeForgeIntegrate([
      { status: "ok", feature_tip_sha: "tip_e2e_smoke" },
    ]);
    const worker = new FakeWorkerSession({
      defaultQueue: [{ kind: "submit_for_review" }],
    });
    const reviewer = new FakeReviewerSession({
      defaultQueue: [{ decision: "approve" }],
    });
    const worktrees = new FakeWorktreePort();

    let run: Run = {
      ...approved.run,
      feature_branch: `lazyorch/${RUN_ID}/feature`,
    };
    let tasks: Task[] = planning.result.tasks.map((t) => ({ ...t }));
    let runtime: SchedulerRuntimeState = emptySchedulerRuntime();
    const routing = { adapters: defaultAdaptersForRouting() };

    // Tick: promote todo→ready, assign worker, submit for review
    let tick = await implementingTick({
      run,
      tasks,
      runtime,
      locks,
      mutex,
      forge,
      worker,
      reviewer,
      worktrees,
      routing,
      now_ms: 1_000,
      nextAgentId,
      run_reviews: false,
      run_integrates: false,
    });
    run = tick.run;
    tasks = tick.tasks;
    runtime = tick.runtime;
    expect(tick.worker_outcomes).toHaveLength(1);
    expect(tasks[0]?.status).toBe("review");

    // Tick: reviewer approve → integrating
    tick = await implementingTick({
      run,
      tasks,
      runtime,
      locks,
      mutex,
      forge,
      worker,
      reviewer,
      worktrees,
      routing,
      now_ms: 2_000,
      nextAgentId,
      run_workers: false,
      run_integrates: false,
    });
    run = tick.run;
    tasks = tick.tasks;
    runtime = tick.runtime;
    expect(tick.review_outcomes[0]?.decision).toBe("approve");
    expect(tasks[0]?.status).toBe("integrating");

    // Tick: forge integrate → done
    tick = await implementingTick({
      run,
      tasks,
      runtime,
      locks,
      mutex,
      forge,
      worker,
      reviewer,
      worktrees,
      routing,
      now_ms: 3_000,
      nextAgentId,
      run_workers: false,
      run_reviews: false,
    });

    expect(tick.integrate_results[0]?.status).toBe("ok");
    expect(tick.tasks[0]?.status).toBe("done");
    expect(tick.run.feature_tip_sha).toBe("tip_e2e_smoke");
    expect(worker.requests.length).toBe(1);
    expect(reviewer.requests.length).toBe(1);
    expect(forge.calls.length).toBe(1);
  });
});
