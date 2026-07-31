import { describe, expect, it } from "vitest";
import type { RouteResult } from "../models/types.js";
import type { Task } from "../types/task.js";
import { assignReadyTasks, releaseTaskScopeLocks } from "./assign.js";
import { FakeScopeLockManager, FakeWorktreePort } from "./fakes.js";
import { SchedulerMetrics } from "./metrics.js";
import { slotLimitsFromConfig } from "./slots.js";
import type { SchedulerSession } from "./types.js";

function task(
  id: string,
  opts: Partial<Task> = {},
): Task {
  return {
    id,
    run_id: "run_1",
    title: `Task ${id}`,
    description: "do work",
    status: "ready",
    origin: "plan",
    priority: 2,
    depends_on: [],
    role_affinity: ["fullstack-dev"],
    scope: [`src/${id}/**`],
    acceptance: [],
    review_criteria: [],
    workspace_mode: "worktree",
    attempt: 1,
    max_attempts: 3,
    artifacts: [],
    ...opts,
  };
}

const limits = slotLimitsFromConfig({
  max_concurrent_agents: 8,
  max_workers: 4,
  max_reviewers: 2,
  max_qa: 2,
  reserve_slots_lead: 1,
});

const fixedRoute: RouteResult = {
  session_kind: "llm",
  score: 42,
  tier: "small",
  adapter_id: "fake-claude",
  model: "fake-small",
  reason: "estimate",
  floor_violated: false,
  pin_locked: false,
  effort: "low",
};

describe("assignReadyTasks", () => {
  it("acquires scope locks, creates worktree, routes model, transitions to in_progress", () => {
    const locks = new FakeScopeLockManager();
    const worktrees = new FakeWorktreePort();
    const metrics = new SchedulerMetrics();
    const t = task("tsk_a");

    const result = assignReadyTasks({
      tasks: [t],
      sessions: [],
      phase: "Implementing",
      limits,
      locks,
      worktrees,
      metrics,
      now_ms: 1000,
      routing: { routeFn: () => fixedRoute },
      nextAgentId: () => "agt_test_1",
    });

    expect(result.assigned).toHaveLength(1);
    const a = result.assigned[0]!;
    expect(a.task.status).toBe("in_progress");
    expect(a.task.assignee).toBe("agt_test_1");
    expect(a.task.worktree_path).toBe("/tmp/wt/run_1/tsk_a");
    expect(a.task.branch).toBe("lazyorch/run_1/tsk_a");
    expect(a.task.last_adapter_id).toBe("fake-claude");
    expect(a.task.last_model_id).toBe("fake-small");
    expect(a.task.last_model_tier).toBe("small");
    expect(a.task.complexity_score).toBe(42);
    expect(a.route.adapter_id).toBe("fake-claude");
    expect(a.session_plan.adapter_id).toBe("fake-claude");
    expect(a.session_plan.reused_idle).toBe(false);
    expect(a.session_plan.run_handle).toBe("pending_tsk_a");
    expect(locks.isHolder("tsk_a")).toBe(true);
    expect(worktrees.created).toHaveLength(1);

    // Metrics include tier/adapter
    expect(metrics.counter("router.tier_selected")).toBe(1);
    expect(metrics.tierCount("small")).toBe(1);
    expect(
      metrics.sessionStartCount({
        adapter: "fake-claude",
        model: "fake-small",
        tier: "small",
      }),
    ).toBe(1);
  });

  it("passes escalate context on retry (attempt > 1 + last_model_tier)", () => {
    const locks = new FakeScopeLockManager();
    let seenEscalate: unknown;
    const result = assignReadyTasks({
      tasks: [
        task("tsk_retry", {
          attempt: 2,
          last_model_tier: "small",
        }),
      ],
      sessions: [],
      phase: "Implementing",
      limits,
      locks,
      now_ms: 1,
      routing: {
        routeFn: (input) => {
          seenEscalate = input.escalate;
          return fixedRoute;
        },
      },
      nextAgentId: () => "agt_retry",
    });
    expect(result.assigned).toHaveLength(1);
    expect(seenEscalate).toEqual({
      consecutive_quality_fails: 1,
      last_model_tier: "small",
    });
  });

  it("does not pass escalate on first attempt", () => {
    const locks = new FakeScopeLockManager();
    let seenEscalate: unknown = "unset";
    assignReadyTasks({
      tasks: [task("tsk_first", { attempt: 1 })],
      sessions: [],
      phase: "Implementing",
      limits,
      locks,
      now_ms: 1,
      routing: {
        routeFn: (input) => {
          seenEscalate = input.escalate;
          return fixedRoute;
        },
      },
      nextAgentId: () => "agt_first",
    });
    expect(seenEscalate).toBeUndefined();
  });

  it("reuses idle worker and does not mint past pool max_workers", () => {
    const locks = new FakeScopeLockManager();
    const sessions = Array.from({ length: 4 }, (_, i) => ({
      run_handle: `idle_${i}`,
      agent_id: `agt_${i}`,
      role: "worker" as const,
      state: "idle" as const,
      last_activity_ms: i,
    }));
    const result = assignReadyTasks({
      tasks: [task("tsk_new", { scope: ["src/new/**"] })],
      sessions,
      phase: "Implementing",
      limits,
      locks,
      now_ms: 1,
      routing: { routeFn: () => fixedRoute },
    });
    expect(result.assigned).toHaveLength(1);
    expect(result.assigned[0]?.session_plan.reused_idle).toBe(true);
    expect(result.assigned[0]?.session_plan.run_handle).toBe("idle_0");
    expect(result.assigned[0]?.task.assignee).toBe("agt_0");
  });

  it("releases lock if routeFn throws after acquire", () => {
    const locks = new FakeScopeLockManager();
    const result = assignReadyTasks({
      tasks: [task("tsk_boom")],
      sessions: [],
      phase: "Implementing",
      limits,
      locks,
      now_ms: 1,
      routing: {
        routeFn: () => {
          throw new Error("route boom");
        },
      },
    });
    expect(result.assigned).toHaveLength(0);
    expect(result.skipped[0]?.reason).toBe("worktree_error");
    expect(locks.isHolder("tsk_boom")).toBe(false);
  });

  it("skips assignment when scope lock conflicts; blocks after wait", () => {
    const locks = new FakeScopeLockManager();
    locks.tryAcquire("holder_other", ["src/tsk_b/**"]);

    const t = task("tsk_b", { scope: ["src/tsk_b/**"] });

    const first = assignReadyTasks({
      tasks: [t],
      sessions: [],
      phase: "Implementing",
      limits,
      locks,
      now_ms: 1000,
      scope_lock_wait_ms: 60_000,
      routing: { routeFn: () => fixedRoute },
    });
    expect(first.assigned).toHaveLength(0);
    expect(first.skipped[0]?.reason).toBe("scope_lock");
    expect(first.blocked).toHaveLength(0);
    expect(first.scope_lock_waits.has("tsk_b")).toBe(true);

    const second = assignReadyTasks({
      tasks: [t],
      sessions: [],
      phase: "Implementing",
      limits,
      locks,
      now_ms: 1000 + 60_000,
      scope_lock_wait_ms: 60_000,
      scope_lock_waits: first.scope_lock_waits,
      routing: { routeFn: () => fixedRoute },
    });
    expect(second.blocked).toHaveLength(1);
    expect(second.blocked[0]?.status).toBe("blocked");
    expect(second.blocked[0]?.blocked_reason).toBe("scope_lock");
    expect(second.skipped[0]?.reason).toBe("scope_lock_blocked");
  });

  it("respects max_workers and free slots with lead reservation", () => {
    const locks = new FakeScopeLockManager();
    const sessions: SchedulerSession[] = Array.from({ length: 4 }, (_, i) => ({
      run_handle: `w${i}`,
      agent_id: `agt_${i}`,
      role: "worker" as const,
      state: "running" as const,
      task_id: `tsk_busy_${i}`,
      last_activity_ms: 0,
    }));

    const result = assignReadyTasks({
      tasks: [task("tsk_new", { scope: ["src/new/**"] })],
      sessions,
      phase: "Implementing",
      limits,
      locks,
      now_ms: 1,
      routing: { routeFn: () => fixedRoute },
    });
    expect(result.assigned).toHaveLength(0);
    expect(result.skipped[0]?.reason).toBe("max_workers");
  });

  it("matches worker template from role_affinity and stamps session_plan", () => {
    const locks = new FakeScopeLockManager();
    let seenPreferred: string[] | undefined;
    const result = assignReadyTasks({
      tasks: [
        task("tsk_be", {
          role_affinity: ["backend"],
          scope: ["src/api/**"],
        }),
      ],
      sessions: [],
      phase: "Implementing",
      limits,
      locks,
      worktrees: new FakeWorktreePort(),
      now_ms: 1,
      worker_templates: ["fullstack-dev", "backend-dev", "frontend-dev"],
      routing: {
        routeFn: (input) => {
          seenPreferred = input.preferred_adapters;
          return fixedRoute;
        },
      },
      nextAgentId: () => "agt_be",
    });
    expect(result.assigned).toHaveLength(1);
    expect(result.assigned[0]!.session_plan.worker_template_id).toBe(
      "backend-dev",
    );
    expect(seenPreferred?.[0]).toBe("claude");
  });

  it("falls back to fullstack-dev when role_affinity matches nothing", () => {
    const locks = new FakeScopeLockManager();
    const result = assignReadyTasks({
      tasks: [
        task("tsk_x", {
          role_affinity: ["obscure-platform"],
          scope: ["src/x/**"],
        }),
      ],
      sessions: [],
      phase: "Implementing",
      limits,
      locks,
      now_ms: 1,
      worker_templates: ["fullstack-dev", "backend-dev", "frontend-dev"],
      routing: { routeFn: () => fixedRoute },
      nextAgentId: () => "agt_x",
    });
    expect(result.assigned[0]!.session_plan.worker_template_id).toBe(
      "fullstack-dev",
    );
  });

  it("matches [backend, worker] design affinity to backend-dev", () => {
    const locks = new FakeScopeLockManager();
    const result = assignReadyTasks({
      tasks: [
        task("tsk_bw", {
          role_affinity: ["backend", "worker"],
          scope: ["src/api/**"],
        }),
      ],
      sessions: [],
      phase: "Implementing",
      limits,
      locks,
      now_ms: 1,
      worker_templates: ["fullstack-dev", "backend-dev", "frontend-dev"],
      routing: { routeFn: () => fixedRoute },
      nextAgentId: () => "agt_bw",
    });
    expect(result.assigned[0]!.session_plan.worker_template_id).toBe(
      "backend-dev",
    );
  });

  it("prefers idle worker whose labels match the template", () => {
    const locks = new FakeScopeLockManager();
    const sessions: SchedulerSession[] = [
      {
        run_handle: "idle_fs",
        agent_id: "agt_fs",
        role: "worker",
        state: "idle",
        last_activity_ms: 0,
        labels: ["fullstack-dev", "worker"],
      },
      {
        run_handle: "idle_be",
        agent_id: "agt_be",
        role: "worker",
        state: "idle",
        last_activity_ms: 10,
        labels: ["backend-dev", "backend", "worker"],
      },
    ];
    const result = assignReadyTasks({
      tasks: [
        task("tsk_be2", {
          role_affinity: ["backend", "worker"],
          scope: ["src/be/**"],
        }),
      ],
      sessions,
      phase: "Implementing",
      limits,
      locks,
      now_ms: 100,
      worker_templates: ["fullstack-dev", "backend-dev", "frontend-dev"],
      routing: { routeFn: () => fixedRoute },
    });
    expect(result.assigned).toHaveLength(1);
    expect(result.assigned[0]!.session_plan.reused_idle).toBe(true);
    expect(result.assigned[0]!.session_plan.run_handle).toBe("idle_be");
    expect(result.assigned[0]!.session_plan.worker_template_id).toBe(
      "backend-dev",
    );
  });

  it("assigns multiple non-overlapping tasks up to free slots", () => {
    const locks = new FakeScopeLockManager();
    const worktrees = new FakeWorktreePort();
    const tasks = [
      task("tsk_1", { scope: ["pkg/a/**"], priority: 1 }),
      task("tsk_2", { scope: ["pkg/b/**"], priority: 2 }),
      task("tsk_3", { scope: ["pkg/c/**"], priority: 3 }),
    ];

    // Only 2 free worker slots after lead reserve: max=3 concurrent, reserve 1
    const tight = slotLimitsFromConfig({
      max_concurrent_agents: 3,
      max_workers: 4,
      max_reviewers: 2,
      max_qa: 2,
      reserve_slots_lead: 1,
    });

    const result = assignReadyTasks({
      tasks,
      sessions: [],
      phase: "Implementing",
      limits: tight,
      locks,
      worktrees,
      now_ms: 1,
      routing: { routeFn: () => fixedRoute },
    });
    // free_for_workers = 3 - 0 - 1 = 2
    expect(result.assigned).toHaveLength(2);
    expect(result.assigned[0]?.task.priority).toBe(1);
    expect(locks.isHolder("tsk_1")).toBe(true);
    expect(locks.isHolder("tsk_2")).toBe(true);
  });

  it("uses real router when no routeFn (no live LLM)", () => {
    const locks = new FakeScopeLockManager();
    const t = task("tsk_route", {
      scope: ["src/x.ts"],
      adapter_override: "shell",
    });

    const result = assignReadyTasks({
      tasks: [t],
      sessions: [],
      phase: "Implementing",
      limits,
      locks,
      now_ms: 1,
      // no routeFn → built-in routeModel; shell override → deterministic
    });
    expect(result.assigned).toHaveLength(1);
    expect(result.assigned[0]?.route.session_kind).toBe("deterministic");
    expect(result.assigned[0]?.route.adapter_id).toBe("shell");
    expect(result.assigned[0]?.route.model).toBe("n/a");
    expect(result.assigned[0]?.route.tier).toBeNull();
  });

  it("releases locks via helper", () => {
    const locks = new FakeScopeLockManager();
    locks.tryAcquire("tsk_z", ["src/z/**"]);
    expect(releaseTaskScopeLocks(locks, "tsk_z")).toBe(1);
    expect(locks.isHolder("tsk_z")).toBe(false);
  });

  it("records worktree_error and releases lock", () => {
    const locks = new FakeScopeLockManager();
    const worktrees = new FakeWorktreePort();
    worktrees.failForTaskIds.add("tsk_fail");
    const result = assignReadyTasks({
      tasks: [task("tsk_fail")],
      sessions: [],
      phase: "Implementing",
      limits,
      locks,
      worktrees,
      now_ms: 1,
      routing: { routeFn: () => fixedRoute },
    });
    expect(result.assigned).toHaveLength(0);
    expect(result.skipped[0]?.reason).toBe("worktree_error");
    expect(locks.isHolder("tsk_fail")).toBe(false);
  });
});
