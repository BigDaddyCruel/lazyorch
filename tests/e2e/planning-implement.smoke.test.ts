/**
 * E2E smoke: planning freeze → plan_approve → implementing tick loop.
 * Uses injectable fakes only (no live LLM, no real git/forge).
 */
import { describe, expect, it } from "vitest";
import {
  SCHEMA_VERSION,
  FakeForgeIntegrate,
  FakeIntegrationMutex,
  FakePlanningSession,
  FakeQaSession,
  FakeReviewerSession,
  FakeScopeLockManager,
  FakeWorktreePort,
  FakeWorkerSession,
  applyPlanApproveDecision,
  defaultAdaptersForRouting,
  emptySchedulerRuntime,
  implementingTick,
  runPlanningPhase,
  type Run,
  type Task,
} from "@lazyorch/core";

const FIXED = "2026-07-31T12:00:00.000Z";
const RUN_ID = "run_e2esmokeaaaaaaaaaaaaaaa";
const PLAN_ID = "plan_e2esmokeaaaaaaaaaaaaaaa";

/** Minimal DESIGN.md with required section headings (freeze validators). */
function validDesignMd(): string {
  return [
    "# Title & metadata",
    "",
    "## Overview",
    "E2E smoke plan freeze + implement.",
    "",
    "## Background & motivation",
    "CI without live LLMs.",
    "",
    "## Goals & non-goals",
    "Goals: freeze + one implement tick path. Non-goals: live adapters.",
    "",
    "## Proposed design",
    "Fake ports only.",
    "",
    "## API / interface changes",
    "None.",
    "",
    "## Data model changes",
    "None.",
    "",
    "## Alternatives considered",
    "1. Live E2E. 2. Record/replay fakes.",
    "",
    "## Security & privacy",
    "No secrets in fixtures.",
    "",
    "## Observability",
    "Freeze hash + task status.",
    "",
    "## Rollout / migration",
    "Test-only.",
    "",
    "## Open questions",
    "None.",
    "",
    "## Key Decisions",
    "| KD | Decision |",
    "|----|----------|",
    "| 1  | Fake ports for E2E |",
    "",
    "## PR Plan / Task DAG",
    "See TASK_DAG.json.",
    "",
  ].join("\n");
}

function smokeArtifacts() {
  return {
    design_md: validDesignMd(),
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

let seq = 0;
function nextAgentId(): string {
  seq += 1;
  return `agt_${String(seq).padStart(24, "a")}`;
}
function nextGateId(): string {
  seq += 1;
  return `gate_${String(seq).padStart(24, "b")}`;
}

describe("E2E smoke: planning freeze + implement tick (fakes)", () => {
  it("freezes plan, approves gate, drives task to done without live LLM", async () => {
    seq = 0;
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
    const qa = new FakeQaSession({
      defaultQueue: [{ passed: true, summary: "e2e QA pass" }],
    });
    const worktrees = new FakeWorktreePort();

    let run = {
      ...approved.run,
      feature_branch: `lazyorch/${RUN_ID}/feature`,
    };
    let tasks: Task[] = planning.result.tasks.map((t) => ({ ...t }));
    let runtime = emptySchedulerRuntime();
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
      qa,
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
      qa,
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
      qa,
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
