import { describe, expect, it } from "vitest";
import type { RouteResult } from "../models/types.js";
import type { Task } from "../types/task.js";
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
  it("assigns ready tasks with router metrics and updates runtime", () => {
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
    expect(result.assign.assigned.length).toBeGreaterThanOrEqual(1);
    expect(result.runtime.sessions.some((s) => s.state === "starting")).toBe(
      true,
    );
    expect(metrics.gauge("scheduler.desired_workers")).toBe(1);
    expect(metrics.gauge("scheduler.slots_used")).toBeGreaterThanOrEqual(1);
    expect(metrics.counter("router.tier_selected")).toBeGreaterThanOrEqual(1);
    expect(metrics.tierCount("nano")).toBeGreaterThanOrEqual(1);
  });

  it("records scale_events on spawn decision", () => {
    const locks = new FakeScopeLockManager();
    const metrics = new SchedulerMetrics();
    const cfg = defaultSchedulerConfig();
    // Many ready tasks, no sessions → scale_up
    const result = schedulerTick({
      tasks: Array.from({ length: 8 }, (_, i) => task(`t${i}`)),
      phase: "Implementing",
      runtime: emptySchedulerRuntime(),
      config: cfg,
      locks,
      metrics,
      now_ms: 10_000,
      routing: { routeFn: () => route },
      // Don't create worktrees for simplicity — empty scope skips worktree need
      // but tasks have scopes; use shared mode without worktree port
    });
    // With worktree port omitted, worktree mode still assigns without paths
    expect(result.scale.action).toBe("spawn");
    expect(metrics.counter("scheduler.scale_events")).toBe(1);
    expect(result.runtime.scale_events).toBe(1);
    expect(result.runtime.last_scale_ms).toBe(10_000);
  });

  it("budget_exhausted sets desired 0 and does not spawn", () => {
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
    expect(result.scale.action).toBe("none");
  });

  it("marks idle clean workers draining on scale-down", () => {
    const locks = new FakeScopeLockManager();
    const cfg = defaultSchedulerConfig();
    // cooldown 0 for test
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
});
