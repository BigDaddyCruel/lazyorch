import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../schema.js";
import { FakeScopeLockManager } from "../scheduler/fakes.js";
import type { Run } from "../types/run.js";
import type { Task } from "../types/task.js";
import {
  drainIntegrateQueue,
  integrateOne,
  sortIntegratingQueue,
} from "./integrate.js";
import { FakeForgeIntegrate, FakeIntegrationMutex } from "./fakes.js";

const FIXED = "2026-04-01T00:00:00.000Z";

function run(partial: Partial<Run> = {}): Run {
  return {
    schema_version: SCHEMA_VERSION,
    id: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
    project_id: "proj",
    phase: "Implementing",
    idea: "implement",
    created_at: FIXED,
    updated_at: FIXED,
    feature_branch: "lazyorch/run_aaaaaaaaaaaaaaaaaaaaaaaa/feature",
    ...partial,
  };
}

function task(
  partial: Partial<Task> & Pick<Task, "id" | "status">,
): Task {
  return {
    id: partial.id,
    run_id: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
    title: "T",
    description: "d",
    status: partial.status,
    origin: "plan",
    priority: 2,
    depends_on: [],
    role_affinity: ["worker"],
    scope: ["src/a/**"],
    acceptance: ["test"],
    review_criteria: ["typecheck"],
    workspace_mode: "worktree",
    attempt: 1,
    max_attempts: 3,
    artifacts: [],
    branch: `lazyorch/run_a/${partial.id}`,
    ...partial,
  };
}

describe("sortIntegratingQueue", () => {
  it("orders by priority then id", () => {
    const q = sortIntegratingQueue([
      task({ id: "tsk_b", status: "integrating", priority: 2 }),
      task({ id: "tsk_a", status: "integrating", priority: 1 }),
      task({ id: "tsk_c", status: "review", priority: 1 }),
      task({ id: "tsk_d", status: "integrating", priority: 1 }),
    ]);
    expect(q.map((t) => t.id)).toEqual(["tsk_a", "tsk_d", "tsk_b"]);
  });
});

describe("integrateOne (KD-33/34)", () => {
  it("success → done, releases mutex and scope locks", async () => {
    const mutex = new FakeIntegrationMutex();
    const forge = new FakeForgeIntegrate([
      { status: "ok", feature_tip_sha: "tip_ok_1" },
    ]);
    const locks = new FakeScopeLockManager();
    locks.tryAcquire("tsk_a", ["src/a/**"]);

    const r = await integrateOne({
      run: run(),
      task: task({ id: "tsk_a", status: "integrating" }),
      forge,
      mutex,
      locks,
    });

    expect(r.task.status).toBe("done");
    expect(r.run.feature_tip_sha).toBe("tip_ok_1");
    expect(r.mutex_released).toBe(true);
    expect(mutex.isHeld(run().id)).toBe(false);
    expect(r.scope_locks_released).toBe(true);
    expect(locks.isHolder("tsk_a")).toBe(false);
    expect(forge.calls[0]?.task_id).toBe("tsk_a");
  });

  it("conflict → blocked/integrate_conflict; mutex released; locks kept", async () => {
    const mutex = new FakeIntegrationMutex();
    const forge = new FakeForgeIntegrate([
      {
        status: "conflict",
        conflict: true,
        error_message: "merge conflict in src/a.ts",
      },
    ]);
    const locks = new FakeScopeLockManager();
    locks.tryAcquire("tsk_a", ["src/a/**"]);

    const r = await integrateOne({
      run: run(),
      task: task({ id: "tsk_a", status: "integrating" }),
      forge,
      mutex,
      locks,
    });

    expect(r.task.status).toBe("blocked");
    expect(r.task.blocked_reason).toBe("integrate_conflict");
    expect(r.mutex_released).toBe(true);
    expect(mutex.isHeld(run().id)).toBe(false);
    expect(r.scope_locks_released).toBe(false);
    expect(locks.isHolder("tsk_a")).toBe(true);
  });

  it("defers when mutex held by another task (no agent slot needed)", async () => {
    const mutex = new FakeIntegrationMutex();
    mutex.tryAcquire(run().id, "tsk_other");
    const forge = new FakeForgeIntegrate();

    const r = await integrateOne({
      run: run(),
      task: task({ id: "tsk_a", status: "integrating" }),
      forge,
      mutex,
    });

    expect(r.deferred).toBe(true);
    expect(r.deferred_holder).toBe("tsk_other");
    expect(forge.calls).toHaveLength(0);
    expect(r.task.status).toBe("integrating");
  });
});

describe("drainIntegrateQueue", () => {
  it("integrates serially under mutex", async () => {
    const mutex = new FakeIntegrationMutex();
    const forge = new FakeForgeIntegrate([
      { status: "ok", feature_tip_sha: "tip1" },
      { status: "ok", feature_tip_sha: "tip2" },
    ]);
    const tasks = [
      task({ id: "tsk_a", status: "integrating", priority: 1 }),
      task({ id: "tsk_b", status: "integrating", priority: 2 }),
    ];

    const r = await drainIntegrateQueue({
      run: run(),
      tasks,
      forge,
      mutex,
    });

    expect(r.results).toHaveLength(2);
    expect(r.tasks.every((t) => t.status === "done")).toBe(true);
    expect(r.run.feature_tip_sha).toBe("tip2");
    expect(mutex.isHeld(run().id)).toBe(false);
  });

  it("stops after conflict but releases mutex for next", async () => {
    const mutex = new FakeIntegrationMutex();
    const forge = new FakeForgeIntegrate([
      {
        status: "conflict",
        conflict: true,
        error_message: "conflict",
      },
      { status: "ok", feature_tip_sha: "tip_b" },
    ]);

    const r = await drainIntegrateQueue({
      run: run(),
      tasks: [
        task({ id: "tsk_a", status: "integrating", priority: 1 }),
        task({ id: "tsk_b", status: "integrating", priority: 2 }),
      ],
      forge,
      mutex,
    });

    expect(r.results).toHaveLength(2);
    expect(r.tasks.find((t) => t.id === "tsk_a")?.status).toBe("blocked");
    expect(r.tasks.find((t) => t.id === "tsk_b")?.status).toBe("done");
  });
});
