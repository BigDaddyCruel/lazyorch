import { describe, expect, it } from "vitest";
import type { RouteResult } from "../models/types.js";
import type { Task } from "../types/task.js";
import { maxAssignTowardDesired } from "./assign.js";
import { FakeScopeLockManager, FakeWorktreePort } from "./fakes.js";
import { SchedulerMetrics } from "./metrics.js";
import {
  defaultSchedulerConfig,
  planElasticity,
  schedulerTick,
} from "./scheduler.js";
import { emptySchedulerRuntime } from "./types.js";
import type { SchedulerSession } from "./types.js";

function task(id: string, opts: Partial<Task> = {}): Task {
  return {
    id,
    run_id: "run_1",
    title: id,
    description: "",
    status: "ready",
    origin: "plan",
    priority: 2,
    depends_on: [],
    role_affinity: [],
    scope: [`scopes/${id}/**`],
    acceptance: [],
    review_criteria: [],
    workspace_mode: "worktree",
    attempt: 1,
    max_attempts: 3,
    artifacts: [],
    ...opts,
  };
}

const route: RouteResult = {
  session_kind: "llm",
  score: 10,
  tier: "nano",
  adapter_id: "fake",
  model: "m-nano",
  reason: "estimate",
  floor_violated: false,
  pin_locked: false,
};

describe("maxAssignTowardDesired", () => {
  it("caps at desired - active_workers", () => {
    expect(
      maxAssignTowardDesired({
        free_for_workers: 7,
        desired: 1,
        active_workers: 0,
      }),
    ).toBe(1);
  });

  it("returns 0 when budget_exhausted", () => {
    expect(
      maxAssignTowardDesired({
        free_for_workers: 7,
        desired: 4,
        active_workers: 0,
        budget_exhausted: true,
      }),
    ).toBe(0);
  });
});

describe("planElasticity", () => {
  it("computes desired from ready count and decides spawn", () => {
    const cfg = defaultSchedulerConfig();
    // 4 ready / ratio 2 → desired 2
    const { desired, scale, free_for_workers } = planElasticity({
      tasks: [task("a"), task("b"), task("c"), task("d")],
      sessions: [],
      elasticity: cfg.elasticity,
      scheduling: cfg.scheduling,
      reserve_slots_lead: 1,
      phase: "Implementing",
      now_ms: 100_000,
      last_scale_ms: 0,
    });
    expect(desired).toBe(2);
    expect(free_for_workers).toBe(7); // 8 - 0 - 1
    expect(scale.action).toBe("spawn");
    expect(scale.spawn_count).toBe(1);
  });
});

describe("schedulerTick", () => {
  it("assigns at most desired workers (ready=2, ratio=2 → desired=1)", () => {
    const locks = new FakeScopeLockManager();
    const worktrees = new FakeWorktreePort();
    const metrics = new SchedulerMetrics();
    const cfg = defaultSchedulerConfig();

    const result = schedulerTick({
      tasks: [task("t1"), task("t2")],
      phase: "Implementing",
      runtime: emptySchedulerRuntime(),
      config: cfg,
      locks,
      worktrees,
      metrics,
      now_ms: 50_000,
      routing: { routeFn: () => route },
    });

    expect(result.desired_workers).toBe(1); // ceil(2/2)=1
    expect(result.assign.assigned).toHaveLength(1);
    expect(result.runtime.sessions.filter((s) => s.state === "starting")).toHaveLength(
      1,
    );
    expect(metrics.gauge("scheduler.desired_workers")).toBe(1);
    expect(metrics.counter("router.tier_selected")).toBe(1);
  });

  it("budget_exhausted assigns zero (drain only)", () => {
    const locks = new FakeScopeLockManager();
    const cfg = defaultSchedulerConfig();
    const result = schedulerTick({
      tasks: [task("x"), task("y"), task("z"), task("w")],
      phase: "Implementing",
      runtime: emptySchedulerRuntime(),
      config: cfg,
      locks,
      budget_exhausted: true,
      now_ms: 1,
      routing: { routeFn: () => route },
    });
    expect(result.desired_workers).toBe(0);
    expect(result.assign.assigned).toHaveLength(0);
    expect(result.scale.spawn_count).toBe(0);
  });

  it("does not double-claim free slots between assign and spawn", () => {
    const locks = new FakeScopeLockManager();
    const cfg = defaultSchedulerConfig();
    // desired=2 (4 ready / 2), free=7, scale_burst=1
    // After assign of 2, pool=2, desired=2 → spawn_count must be 0
    const result = schedulerTick({
      tasks: [task("a"), task("b"), task("c"), task("d")],
      phase: "Implementing",
      runtime: emptySchedulerRuntime(),
      config: cfg,
      locks,
      now_ms: 10_000,
      routing: { routeFn: () => route },
    });
    expect(result.desired_workers).toBe(2);
    expect(result.assign.assigned).toHaveLength(2);
    // Assign filled desired — no additional idle pre-warm
    expect(result.scale.spawn_count).toBe(0);
    expect(result.scale.action).not.toBe("spawn");
    const pool = result.runtime.sessions.filter(
      (s) => s.role === "worker" && s.state !== "draining",
    ).length;
    expect(pool).toBe(2);
  });

  it("reuses idle pool workers instead of minting past max_workers", () => {
    const locks = new FakeScopeLockManager();
    const cfg = defaultSchedulerConfig();
    const idleSessions: SchedulerSession[] = Array.from(
      { length: 4 },
      (_, i) => ({
        run_handle: `idle_${i}`,
        agent_id: `agt_idle_${i}`,
        role: "worker" as const,
        state: "idle" as const,
        worktree_clean: true,
        last_activity_ms: i,
      }),
    );
    const runtime = emptySchedulerRuntime();
    runtime.sessions = idleSessions;

    // 1 ready → desired=1; must reuse idle_0, not mint 5th
    const result = schedulerTick({
      tasks: [task("only")],
      phase: "Implementing",
      runtime,
      config: cfg,
      locks,
      now_ms: 1000,
      routing: { routeFn: () => route },
    });
    expect(result.assign.assigned).toHaveLength(1);
    expect(result.assign.assigned[0]?.session_plan.reused_idle).toBe(true);
    expect(result.assign.assigned[0]?.session_plan.run_handle).toBe("idle_0");
    expect(result.assign.assigned[0]?.session_plan.agent_id).toBe("agt_idle_0");
    // Pool still 4 — no 5th member
    const pool = result.runtime.sessions.filter(
      (s) => s.role === "worker" && s.state !== "draining",
    );
    expect(pool).toHaveLength(4);
    const claimed = pool.find((s) => s.run_handle === "idle_0");
    expect(claimed?.state).toBe("starting");
    expect(claimed?.task_id).toBe("only");
  });

  it("4 idle at max_workers + ready does not mint a 5th", () => {
    const locks = new FakeScopeLockManager();
    const cfg = defaultSchedulerConfig();
    cfg.elasticity.max_workers = 4;
    // Force high desired so cap is max_workers not desired
    cfg.elasticity.scale_up_ready_ratio = 1;
    const runtime = emptySchedulerRuntime();
    runtime.sessions = Array.from({ length: 4 }, (_, i) => ({
      run_handle: `i${i}`,
      agent_id: `a${i}`,
      role: "worker" as const,
      state: "idle" as const,
      last_activity_ms: 0,
    }));

    const result = schedulerTick({
      tasks: [task("r1"), task("r2"), task("r3"), task("r4"), task("r5")],
      phase: "Implementing",
      runtime,
      config: cfg,
      locks,
      now_ms: 1,
      routing: { routeFn: () => route },
    });
    // desired = min(5, 4) = 4; active busy=0 → max_assign=4; all reuses
    expect(result.assign.assigned).toHaveLength(4);
    expect(
      result.assign.assigned.every((a) => a.session_plan.reused_idle),
    ).toBe(true);
    expect(
      result.runtime.sessions.filter((s) => s.role === "worker").length,
    ).toBe(4);
  });

  it("marks idle clean workers draining on scale-down", () => {
    const locks = new FakeScopeLockManager();
    const cfg = defaultSchedulerConfig();
    cfg.elasticity.cooldown_seconds = 0;
    cfg.elasticity.scale_down_idle_minutes = 0;

    const idle: SchedulerSession = {
      run_handle: "idle_w",
      agent_id: "agt_idle",
      role: "worker",
      state: "idle",
      worktree_clean: true,
      last_activity_ms: 0,
    };

    const runtime = emptySchedulerRuntime();
    runtime.sessions = [idle];
    runtime.last_scale_ms = 0;

    const result = schedulerTick({
      tasks: [], // ready=0 → desired=0
      phase: "Implementing",
      runtime,
      config: cfg,
      locks,
      now_ms: 1000,
      routing: { routeFn: () => route },
    });
    expect(result.desired_workers).toBe(0);
    expect(result.scale.action).toBe("drain");
    expect(
      result.runtime.sessions.find((s) => s.run_handle === "idle_w")?.state,
    ).toBe("draining");
  });

  it("does not drain idle worker reused for assign in the same tick (Issue 11)", () => {
    const locks = new FakeScopeLockManager();
    const cfg = defaultSchedulerConfig();
    cfg.elasticity.cooldown_seconds = 0;
    cfg.elasticity.scale_down_idle_minutes = 0;
    // 2 idle clean workers, 1 ready → desired=1; pre-scale wants drain of 1
    // pickIdleWorker and drain both prefer oldest (idle_a) — must not collide
    const runtime = emptySchedulerRuntime();
    runtime.sessions = [
      {
        run_handle: "idle_a",
        agent_id: "agt_a",
        role: "worker",
        state: "idle",
        worktree_clean: true,
        last_activity_ms: 0,
      },
      {
        run_handle: "idle_b",
        agent_id: "agt_b",
        role: "worker",
        state: "idle",
        worktree_clean: true,
        last_activity_ms: 1,
      },
    ];
    runtime.last_scale_ms = 0;

    const result = schedulerTick({
      tasks: [task("work")],
      phase: "Implementing",
      runtime,
      config: cfg,
      locks,
      now_ms: 1000,
      routing: { routeFn: () => route },
    });

    expect(result.desired_workers).toBe(1);
    expect(result.assign.assigned).toHaveLength(1);
    expect(result.assign.assigned[0]?.session_plan.reused_idle).toBe(true);
    const reused = result.assign.assigned[0]!.session_plan.run_handle;
    expect(reused).toBe("idle_a");

    // Reused worker stays starting with task — never draining
    const a = result.runtime.sessions.find((s) => s.run_handle === "idle_a");
    expect(a?.state).toBe("starting");
    expect(a?.task_id).toBe("work");

    // The other idle is drained (pool 2 → desired 1)
    expect(result.scale.action).toBe("drain");
    expect(result.scale.drain_handles).toEqual(["idle_b"]);
    expect(result.scale.drain_handles).not.toContain(reused);
    const b = result.runtime.sessions.find((s) => s.run_handle === "idle_b");
    expect(b?.state).toBe("draining");
  });

  it("records scale_events on drain", () => {
    const locks = new FakeScopeLockManager();
    const metrics = new SchedulerMetrics();
    const cfg = defaultSchedulerConfig();
    cfg.elasticity.cooldown_seconds = 0;
    cfg.elasticity.scale_down_idle_minutes = 0;
    const runtime = emptySchedulerRuntime();
    runtime.sessions = [
      {
        run_handle: "idle_w",
        agent_id: "agt",
        role: "worker",
        state: "idle",
        worktree_clean: true,
        last_activity_ms: 0,
      },
    ];
    const result = schedulerTick({
      tasks: [],
      phase: "Implementing",
      runtime,
      config: cfg,
      locks,
      metrics,
      now_ms: 10_000,
      routing: { routeFn: () => route },
    });
    expect(result.scale.action).toBe("drain");
    expect(metrics.counter("scheduler.scale_events")).toBe(1);
  });
});
