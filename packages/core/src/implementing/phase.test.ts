import { describe, expect, it } from "vitest";
import { defaultAdaptersForRouting } from "../models/defaults.js";
import { SCHEMA_VERSION } from "../schema.js";
import {
  defaultSchedulerConfig,
  emptySchedulerRuntime,
  FakeScopeLockManager,
  FakeWorktreePort,
} from "../scheduler/index.js";
import type { Run } from "../types/run.js";
import type { Task } from "../types/task.js";
import {
  FakeForgeIntegrate,
  FakeIntegrationMutex,
  FakeQaSession,
  FakeReviewerSession,
  FakeWorkerSession,
} from "./fakes.js";
import {
  implementingTick,
  prepareImplementingReplan,
  resumeImplementingAfterReplan,
} from "./phase.js";

const FIXED = "2026-04-01T00:00:00.000Z";
const RUN_ID = "run_aaaaaaaaaaaaaaaaaaaaaaaa";

function run(partial: Partial<Run> = {}): Run {
  return {
    schema_version: SCHEMA_VERSION,
    id: RUN_ID,
    project_id: "proj",
    phase: "Implementing",
    idea: "implement phase",
    created_at: FIXED,
    updated_at: FIXED,
    feature_branch: `lazyorch/${RUN_ID}/feature`,
    ...partial,
  };
}

function task(
  partial: Partial<Task> & Pick<Task, "id" | "status">,
): Task {
  return {
    id: partial.id,
    run_id: RUN_ID,
    title: partial.title ?? partial.id,
    description: "d",
    status: partial.status,
    origin: "plan",
    priority: 2,
    depends_on: [],
    role_affinity: ["worker"],
    scope: partial.scope ?? [`src/${partial.id}/**`],
    acceptance: ["test"],
    review_criteria: ["typecheck"],
    workspace_mode: "worktree",
    attempt: 1,
    max_attempts: 3,
    artifacts: [],
    ...partial,
  };
}

let seq = 0;
function nextAgentId() {
  seq += 1;
  return `agt_${String(seq).padStart(24, "a")}`;
}

describe("implementingTick — assign/review/integrate loop", () => {
  it("drives ready → in_progress → review → integrating → done (fakes)", async () => {
    seq = 0;
    const locks = new FakeScopeLockManager();
    const mutex = new FakeIntegrationMutex();
    const forge = new FakeForgeIntegrate([
      { status: "ok", feature_tip_sha: "tip_final" },
    ]);
    const worker = new FakeWorkerSession({
      defaultQueue: [{ kind: "submit_for_review" }],
    });
    const reviewer = new FakeReviewerSession({
      defaultQueue: [{ decision: "approve" }],
    });
    const worktrees = new FakeWorktreePort();

    let state = {
      run: run(),
      tasks: [task({ id: "tsk_a", status: "ready", scope: ["src/a/**"] })],
      runtime: emptySchedulerRuntime(),
    };

    // Tick 1: assign + worker submit
    let tick = await implementingTick({
      ...state,
      locks,
      mutex,
      forge,
      worker,
      reviewer,
      worktrees,
      routing: { adapters: defaultAdaptersForRouting() },
      now_ms: 1_000,
      nextAgentId,
      run_reviews: false,
      run_integrates: false,
    });
    state = { run: tick.run, tasks: tick.tasks, runtime: tick.runtime };

    expect(tick.worker_outcomes).toHaveLength(1);
    expect(state.tasks[0]?.status).toBe("review");
    expect(locks.isHolder("tsk_a")).toBe(true);

    // Tick 2: review approve
    tick = await implementingTick({
      ...state,
      locks,
      mutex,
      forge,
      worker,
      reviewer,
      worktrees,
      routing: { adapters: defaultAdaptersForRouting() },
      now_ms: 2_000,
      nextAgentId,
      run_workers: false,
      run_integrates: false,
    });
    state = { run: tick.run, tasks: tick.tasks, runtime: tick.runtime };
    expect(tick.review_outcomes[0]?.decision).toBe("approve");
    expect(state.tasks[0]?.status).toBe("integrating");

    // Tick 3: integrate
    tick = await implementingTick({
      ...state,
      locks,
      mutex,
      forge,
      worktrees,
      routing: { adapters: defaultAdaptersForRouting() },
      now_ms: 3_000,
      nextAgentId,
      run_workers: false,
      run_reviews: false,
    });

    expect(tick.integrate_results[0]?.status).toBe("ok");
    expect(tick.tasks[0]?.status).toBe("done");
    expect(tick.run.feature_tip_sha).toBe("tip_final");
    expect(locks.isHolder("tsk_a")).toBe(false);
    expect(mutex.isHeld(RUN_ID)).toBe(false);
  });

  it("parallel ready tasks assign under scope locks", async () => {
    seq = 0;
    const locks = new FakeScopeLockManager();
    const mutex = new FakeIntegrationMutex();
    const forge = new FakeForgeIntegrate();
    const worktrees = new FakeWorktreePort();
    const config = {
      ...defaultSchedulerConfig(),
      elasticity: {
        ...defaultSchedulerConfig().elasticity,
        min_workers: 0,
        max_workers: 4,
        scale_burst: 2,
      },
    };

    const tick = await implementingTick({
      run: run(),
      tasks: [
        task({ id: "tsk_a", status: "ready", scope: ["src/a/**"] }),
        task({ id: "tsk_b", status: "ready", scope: ["src/b/**"] }),
      ],
      runtime: emptySchedulerRuntime(),
      locks,
      mutex,
      forge,
      worktrees,
      config,
      routing: { adapters: defaultAdaptersForRouting() },
      now_ms: 1_000,
      nextAgentId,
      run_workers: false,
      run_reviews: false,
      run_integrates: false,
    });

    expect(tick.scheduler?.assign.assigned.length).toBeGreaterThanOrEqual(1);
    const inProg = tick.tasks.filter((t) => t.status === "in_progress");
    expect(inProg.length).toBeGreaterThanOrEqual(1);
    for (const t of inProg) {
      expect(locks.isHolder(t.id)).toBe(true);
    }
    // Overlapping scopes still conflict: second task with same scope stays ready
    const conflictLocks = new FakeScopeLockManager();
    const overlap = await implementingTick({
      run: run(),
      tasks: [
        task({ id: "tsk_x", status: "ready", scope: ["src/shared/**"] }),
        task({ id: "tsk_y", status: "ready", scope: ["src/shared/**"] }),
      ],
      runtime: emptySchedulerRuntime(),
      locks: conflictLocks,
      mutex: new FakeIntegrationMutex(),
      forge: new FakeForgeIntegrate(),
      worktrees: new FakeWorktreePort(),
      config,
      routing: { adapters: defaultAdaptersForRouting() },
      now_ms: 1_000,
      nextAgentId,
      run_workers: false,
      run_reviews: false,
      run_integrates: false,
    });
    const holders = ["tsk_x", "tsk_y"].filter((id) =>
      conflictLocks.isHolder(id),
    );
    expect(holders).toHaveLength(1);
    expect(
      overlap.tasks.filter((t) => t.status === "in_progress"),
    ).toHaveLength(1);
  });

  it("integrate conflict keeps locks and recovers to ready", async () => {
    seq = 0;
    const locks = new FakeScopeLockManager();
    locks.tryAcquire("tsk_a", ["src/a/**"]);
    const mutex = new FakeIntegrationMutex();
    const forge = new FakeForgeIntegrate([
      {
        status: "conflict",
        conflict: true,
        error_message: "CONFLICT src/a.ts",
      },
    ]);

    // First tick: integrating → conflict blocked
    let tick = await implementingTick({
      run: run(),
      tasks: [
        task({
          id: "tsk_a",
          status: "integrating",
          scope: ["src/a/**"],
          attempt: 1,
        }),
      ],
      runtime: emptySchedulerRuntime(),
      locks,
      mutex,
      forge,
      now_ms: 1_000,
      auto_recover_integrate_conflict: false,
      run_workers: false,
      run_reviews: false,
    });

    expect(tick.tasks[0]?.status).toBe("blocked");
    expect(tick.tasks[0]?.blocked_reason).toBe("integrate_conflict");
    expect(locks.isHolder("tsk_a")).toBe(true);
    expect(mutex.isHeld(RUN_ID)).toBe(false);

    // Second tick: auto recover → ready, then scheduler may re-assign
    // (same holder re-acquires locks idempotently; locks stay held).
    tick = await implementingTick({
      run: tick.run,
      tasks: tick.tasks,
      runtime: tick.runtime,
      locks,
      mutex,
      forge: new FakeForgeIntegrate(),
      worktrees: new FakeWorktreePort(),
      routing: { adapters: defaultAdaptersForRouting() },
      now_ms: 2_000,
      nextAgentId,
      auto_recover_integrate_conflict: true,
      run_workers: false,
      run_reviews: false,
      run_integrates: false,
    });

    expect(tick.recovered_conflict_ids).toEqual(["tsk_a"]);
    // Recovered to ready then possibly assigned again same tick
    expect(["ready", "in_progress"]).toContain(tick.tasks[0]?.status);
    expect(tick.tasks[0]?.attempt).toBe(2);
    expect(locks.isHolder("tsk_a")).toBe(true);
  });

  it("escalates model tier on retry assign (router)", async () => {
    seq = 0;
    const locks = new FakeScopeLockManager();
    const mutex = new FakeIntegrationMutex();
    const forge = new FakeForgeIntegrate();
    const worktrees = new FakeWorktreePort();

    // Task already failed once: attempt 2, last_model_tier small
    const tick = await implementingTick({
      run: run(),
      tasks: [
        task({
          id: "tsk_a",
          status: "ready",
          scope: ["src/a/**"],
          attempt: 2,
          last_model_tier: "small",
        }),
      ],
      runtime: emptySchedulerRuntime(),
      locks,
      mutex,
      forge,
      worktrees,
      routing: {
        adapters: defaultAdaptersForRouting(),
        // avoid budget cap crushing escalate for the assertion
        config: {
          escalate_on_failure: true,
          escalate_after_failures: 1,
          budget_tier_cap: "xlarge",
          max_tier: "xlarge",
        },
      },
      now_ms: 1_000,
      nextAgentId,
      run_workers: false,
      run_reviews: false,
      run_integrates: false,
    });

    const assigned = tick.scheduler?.assign.assigned[0];
    expect(assigned).toBeDefined();
    // escalate: max(est, nextTier(small)=medium) — reason escalate or higher
    expect(assigned?.route.tier).not.toBe("nano");
    expect(["medium", "large", "xlarge", "small"]).toContain(
      assigned?.route.tier,
    );
    // With last small + escalate, should be at least medium
    expect(
      ["medium", "large", "xlarge"].includes(assigned?.route.tier as string) ||
        assigned?.route.reason === "escalate",
    ).toBe(true);
    expect(assigned?.task.last_model_tier).toBeDefined();
  });

  it("terminal failed opens human_intervention gate", async () => {
    const locks = new FakeScopeLockManager();
    const mutex = new FakeIntegrationMutex();
    const forge = new FakeForgeIntegrate();

    const tick = await implementingTick({
      run: run(),
      tasks: [
        task({
          id: "tsk_a",
          status: "failed",
          attempt: 3,
          max_attempts: 3,
        }),
      ],
      runtime: emptySchedulerRuntime(),
      locks,
      mutex,
      forge,
      now_ms: 1_000,
      nextGateId: () => "gate_human_1",
      run_workers: false,
      run_reviews: false,
      run_integrates: false,
    });

    expect(tick.gates).toHaveLength(1);
    expect(tick.gates[0]?.type).toBe("human_intervention");
    expect(tick.run.phase).toBe("Implementing");
  });

  it("KD-36 gate is idempotent across ticks with existing_gates", async () => {
    const locks = new FakeScopeLockManager();
    const mutex = new FakeIntegrationMutex();
    const forge = new FakeForgeIntegrate();
    const tasks = [
      task({ id: "tsk_a", status: "failed", attempt: 3, max_attempts: 3 }),
    ];

    const first = await implementingTick({
      run: run(),
      tasks,
      runtime: emptySchedulerRuntime(),
      locks,
      mutex,
      forge,
      now_ms: 1_000,
      nextGateId: () => "gate_human_1",
      run_workers: false,
      run_reviews: false,
      run_integrates: false,
    });
    expect(first.gates).toHaveLength(1);

    const second = await implementingTick({
      run: first.run,
      tasks,
      runtime: first.runtime,
      locks,
      mutex,
      forge,
      existing_gates: first.gates,
      now_ms: 2_000,
      nextGateId: () => "gate_human_2",
      run_workers: false,
      run_reviews: false,
      run_integrates: false,
    });
    expect(second.gates).toHaveLength(0);
    expect(second.escalated_task_ids).toHaveLength(0);
  });

  it("releases path-scope locks on terminal worker failed", async () => {
    seq = 0;
    const locks = new FakeScopeLockManager();
    const mutex = new FakeIntegrationMutex();
    const forge = new FakeForgeIntegrate();
    const worktrees = new FakeWorktreePort();
    const worker = new FakeWorkerSession({
      defaultQueue: [{ kind: "fail" }],
    });

    // Assign + fail in one tick (worker runs after assign)
    const tick = await implementingTick({
      run: run(),
      tasks: [
        task({
          id: "tsk_a",
          status: "ready",
          scope: ["src/a/**"],
          attempt: 3,
          max_attempts: 3,
        }),
      ],
      runtime: emptySchedulerRuntime(),
      locks,
      mutex,
      forge,
      worktrees,
      worker,
      routing: { adapters: defaultAdaptersForRouting() },
      now_ms: 1_000,
      nextAgentId,
      run_workers: true,
      run_reviews: false,
      run_integrates: false,
    });

    expect(tick.tasks[0]?.status).toBe("failed");
    expect(locks.isHolder("tsk_a")).toBe(false);
  });

  it("does not start reviewers when max_reviewers is 0", async () => {
    const locks = new FakeScopeLockManager();
    const mutex = new FakeIntegrationMutex();
    const forge = new FakeForgeIntegrate();
    const reviewer = new FakeReviewerSession({
      defaultQueue: [{ decision: "approve" }],
    });
    const config = defaultSchedulerConfig();
    config.team = { ...config.team, max_reviewers: 0, min_reviewers: 0 };

    const tick = await implementingTick({
      run: run(),
      tasks: [task({ id: "tsk_a", status: "review", scope: ["src/a/**"] })],
      runtime: emptySchedulerRuntime(),
      locks,
      mutex,
      forge,
      reviewer,
      config,
      routing: { adapters: defaultAdaptersForRouting() },
      now_ms: 1_000,
      nextAgentId,
      run_workers: false,
      run_reviews: true,
      run_integrates: false,
    });

    expect(reviewer.requests).toHaveLength(0);
    expect(tick.review_outcomes).toHaveLength(0);
    expect(tick.tasks[0]?.status).toBe("review");
  });

  it("conflict storm at max_attempts opens gate and stays blocked", async () => {
    const locks = new FakeScopeLockManager();
    locks.tryAcquire("tsk_a", ["src/a/**"]);
    const mutex = new FakeIntegrationMutex();
    const forge = new FakeForgeIntegrate();

    const tick = await implementingTick({
      run: run(),
      tasks: [
        task({
          id: "tsk_a",
          status: "blocked",
          blocked_reason: "integrate_conflict",
          integrate_error: "CONFLICT",
          scope: ["src/a/**"],
          attempt: 3,
          max_attempts: 3,
        }),
      ],
      runtime: emptySchedulerRuntime(),
      locks,
      mutex,
      forge,
      now_ms: 1_000,
      nextGateId: () => "gate_storm_1",
      auto_recover_integrate_conflict: true,
      run_workers: false,
      run_reviews: false,
      run_integrates: false,
    });

    expect(tick.recovered_conflict_ids).toHaveLength(0);
    expect(tick.conflict_storm_ids).toEqual(["tsk_a"]);
    expect(tick.tasks[0]?.status).toBe("blocked");
    expect(tick.gates).toHaveLength(1);
    expect(tick.gates[0]?.payload.reason).toBe("integrate_conflict_storm");
    expect(locks.isHolder("tsk_a")).toBe(true);
  });

  it("run-level QA pass then exit → PrePR (or CILoop with ready PR)", async () => {
    const locks = new FakeScopeLockManager();
    const mutex = new FakeIntegrationMutex();
    const forge = new FakeForgeIntegrate();
    const qa = new FakeQaSession({
      defaultQueue: [{ passed: true, summary: "smoke ok" }],
    });

    const tick = await implementingTick({
      run: run({ feature_tip_sha: "tip_qa" }),
      tasks: [task({ id: "tsk_a", status: "done" })],
      runtime: emptySchedulerRuntime(),
      locks,
      mutex,
      forge,
      qa,
      try_exit: true,
      routing: { adapters: defaultAdaptersForRouting() },
      now_ms: 1_000,
      nextAgentId,
      run_workers: false,
      run_reviews: false,
      run_integrates: false,
    });

    expect(qa.requests).toHaveLength(1);
    expect(qa.requests[0]?.feature_tip_sha).toBe("tip_qa");
    expect(tick.qa_outcomes).toEqual([{ passed: true, summary: "smoke ok" }]);
    expect(tick.run.qa?.passed_at_commit).toBe("tip_qa");
    expect(tick.exited).toBe(true);
    expect(tick.run.phase).toBe("PrePR");
  });

  it("run-level QA fail opens dynamic fix tasks and does not exit", async () => {
    const locks = new FakeScopeLockManager();
    const mutex = new FakeIntegrationMutex();
    const forge = new FakeForgeIntegrate();
    const qa = new FakeQaSession({
      defaultQueue: [{ passed: false, summary: "broken" }],
    });

    const tick = await implementingTick({
      run: run({ feature_tip_sha: "tip_qa" }),
      tasks: [task({ id: "tsk_a", status: "done" })],
      runtime: emptySchedulerRuntime(),
      locks,
      mutex,
      forge,
      qa,
      try_exit: true,
      routing: { adapters: defaultAdaptersForRouting() },
      now_ms: 1_000,
      nextTaskId: () => "tsk_fixfixfixfixfixfixfixfix",
      run_workers: false,
      run_reviews: false,
      run_integrates: false,
    });

    expect(tick.exited).toBe(false);
    expect(tick.run.phase).toBe("Implementing");
    expect(tick.qa_fix_task_ids).toHaveLength(1);
    expect(tick.tasks.some((t) => t.origin === "dynamic")).toBe(true);
  });

  it("exit short-circuits to CILoop when ready PR exists after QA", async () => {
    const locks = new FakeScopeLockManager();
    const mutex = new FakeIntegrationMutex();
    const forge = new FakeForgeIntegrate();
    const qa = new FakeQaSession({ defaultQueue: [{ passed: true }] });

    const tick = await implementingTick({
      run: run({
        feature_tip_sha: "tip_qa",
        pr_ref: { number: 4, state: "ready" },
      }),
      tasks: [task({ id: "tsk_a", status: "done" })],
      runtime: emptySchedulerRuntime(),
      locks,
      mutex,
      forge,
      qa,
      try_exit: true,
      routing: { adapters: defaultAdaptersForRouting() },
      now_ms: 1_000,
      run_workers: false,
      run_reviews: false,
      run_integrates: false,
    });

    expect(tick.exited).toBe(true);
    expect(tick.run.phase).toBe("CILoop");
  });
});

describe("replan protocol hooks", () => {
  it("prepareImplementingReplan supersedes open tasks and releases locks", () => {
    const locks = new FakeScopeLockManager();
    locks.tryAcquire("tsk_a", ["src/a/**"]);
    locks.tryAcquire("tsk_b", ["src/b/**"]);

    const result = prepareImplementingReplan(
      run(),
      [
        task({ id: "tsk_a", status: "in_progress", scope: ["src/a/**"] }),
        task({ id: "tsk_b", status: "ready", scope: ["src/b/**"] }),
        task({ id: "tsk_done", status: "done", scope: ["src/c/**"] }),
      ],
      "plan_rev_002",
      { locks },
    );

    expect(result.run.phase).toBe("Planning");
    expect(result.cancelled_ids.sort()).toEqual(["tsk_a", "tsk_b"]);
    expect(result.preserved_done_ids).toEqual(["tsk_done"]);
    expect(locks.isHolder("tsk_a")).toBe(false);
    expect(locks.isHolder("tsk_b")).toBe(false);
    expect(
      result.tasks.find((t) => t.id === "tsk_a")?.superseded_by_plan,
    ).toBe("plan_rev_002");
  });

  it("resumeImplementingAfterReplan requires frozen plan", () => {
    const frozen = {
      schema_version: SCHEMA_VERSION,
      id: "plan_bbbbbbbbbbbbbbbbbbbbbbbb",
      run_id: RUN_ID,
      revision: 2,
      status: "frozen" as const,
      freeze_hash: "a".repeat(64),
      issues: [],
      task_ids: [],
      created_at: FIXED,
      updated_at: FIXED,
    };

    const next = resumeImplementingAfterReplan(
      run({ phase: "PlanConsensus", plan_id: frozen.id }),
      { plan: frozen },
    );
    expect(next.phase).toBe("Implementing");
  });
});
