import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../schema.js";
import type { Run } from "../types/run.js";
import type { Task } from "../types/task.js";
import { TaskFsmError } from "./task-fsm.js";
import { RunFsmError } from "./run-fsm.js";
import {
  applySimEvent,
  advanceParallel,
  simulateImplementingToExit,
  SimulatorError,
  tryExitImplementing,
  type SimState,
} from "./simulator.js";

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    schema_version: SCHEMA_VERSION,
    id: "run_sim",
    project_id: "prj_1",
    phase: "Implementing",
    idea: "parallel work",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    feature_tip_sha: "tip0",
    ...overrides,
  };
}

function makeTask(
  id: string,
  overrides: Partial<Task> = {},
): Task {
  return {
    id,
    run_id: "run_sim",
    title: id,
    description: "",
    status: "todo",
    origin: "plan",
    priority: 2,
    depends_on: [],
    role_affinity: ["worker"],
    scope: [`${id}/**`],
    acceptance: ["ok"],
    review_criteria: ["lint"],
    workspace_mode: "worktree",
    attempt: 0,
    max_attempts: 3,
    artifacts: [],
    ...overrides,
  };
}

function state(tasks: Task[], runOverrides: Partial<Run> = {}): SimState {
  return { run: makeRun(runOverrides), tasks };
}

describe("simulator", () => {
  it("rejects illegal task transitions", () => {
    const s = state([makeTask("tsk_a", { status: "todo" })]);
    expect(() =>
      applySimEvent(s, {
        type: "task_transition",
        task_id: "tsk_a",
        to: "done",
      }),
    ).toThrow(TaskFsmError);
  });

  it("rejects illegal run transitions", () => {
    const s = state([], { phase: "Inception" });
    expect(() =>
      applySimEvent(s, { type: "run_transition", to: "Merged" }),
    ).toThrow(RunFsmError);
  });

  it("advances independent tasks in parallel under Implementing", () => {
    let s = state([
      makeTask("tsk_a", { priority: 1 }),
      makeTask("tsk_b", { priority: 1 }),
    ]);

    // tick: todo→ready, ready→in_progress (both, unlimited)
    s = advanceParallel(s);
    expect(s.tasks.map((t) => t.status).sort()).toEqual([
      "in_progress",
      "in_progress",
    ]);

    s = advanceParallel(s);
    expect(s.tasks.every((t) => t.status === "review")).toBe(true);

    s = advanceParallel(s);
    expect(s.tasks.every((t) => t.status === "integrating")).toBe(true);

    s = advanceParallel(s);
    expect(s.tasks.every((t) => t.status === "done")).toBe(true);
    expect(s.run.feature_tip_sha).not.toBe("tip0");
  });

  it("respects max_concurrent slots", () => {
    let s = state([
      makeTask("tsk_a", { priority: 1 }),
      makeTask("tsk_b", { priority: 2 }),
      makeTask("tsk_c", { priority: 3 }),
    ]);
    s = advanceParallel(s, 1);
    const statuses = Object.fromEntries(s.tasks.map((t) => [t.id, t.status]));
    expect(statuses["tsk_a"]).toBe("in_progress");
    expect(statuses["tsk_b"]).toBe("ready");
    expect(statuses["tsk_c"]).toBe("ready");
  });

  it("honors dependency order (dependent waits)", () => {
    let s = state([
      makeTask("tsk_root"),
      makeTask("tsk_child", { depends_on: ["tsk_root"] }),
    ]);
    s = advanceParallel(s, 10);
    const byId = Object.fromEntries(s.tasks.map((t) => [t.id, t.status]));
    expect(byId["tsk_root"]).toBe("in_progress");
    expect(byId["tsk_child"]).toBe("todo"); // deps not done

    // finish root: review → integrating → done
    for (let i = 0; i < 3; i++) s = advanceParallel(s, 10);
    expect(s.tasks.find((t) => t.id === "tsk_root")!.status).toBe("done");
    expect(s.tasks.find((t) => t.id === "tsk_child")!.status).toBe("todo");

    s = advanceParallel(s, 10);
    expect(s.tasks.find((t) => t.id === "tsk_child")!.status).toBe(
      "in_progress",
    );
  });

  it("exits Implementing → PrePR when no ready PR", () => {
    let s = state([makeTask("tsk_a", { status: "done" })], {
      feature_tip_sha: "tip1",
      qa: { passed_at_commit: "tip1" },
    });
    s = tryExitImplementing(s);
    expect(s.run.phase).toBe("PrePR");
  });

  it("exits Implementing → CILoop when ready PR exists", () => {
    let s = state([makeTask("tsk_a", { status: "done" })], {
      feature_tip_sha: "tip1",
      qa: { passed_at_commit: "tip1" },
      pr_ref: { number: 42, state: "ready" },
    });
    s = tryExitImplementing(s);
    expect(s.run.phase).toBe("CILoop");
  });

  it("throws when exit predicate not met", () => {
    const s = state([makeTask("tsk_a", { status: "in_progress" })]);
    expect(() => tryExitImplementing(s)).toThrow(SimulatorError);
  });

  it("simulateImplementingToExit drives multi-task run to PrePR", () => {
    const s0 = state([
      makeTask("tsk_a"),
      makeTask("tsk_b", { depends_on: ["tsk_a"] }),
      makeTask("tsk_c"),
    ]);
    const s = simulateImplementingToExit(s0, { max_concurrent: 2 });
    expect(s.tasks.every((t) => t.status === "done")).toBe(true);
    expect(s.run.phase).toBe("PrePR");
    expect(s.run.qa?.passed_at_commit).toBe(s.run.feature_tip_sha);
  });

  it("CILoop re-entry: after fixes + ready PR, exit back to CILoop", () => {
    let s = state(
      [makeTask("tsk_fix", { origin: "dynamic", status: "todo" })],
      {
        phase: "Implementing",
        feature_tip_sha: "old",
        pr_ref: { number: 7, state: "ready" },
      },
    );
    s = simulateImplementingToExit(s);
    expect(s.run.phase).toBe("CILoop");
    expect(s.tasks[0]!.status).toBe("done");
  });

  it("supports review reject → ready via events", () => {
    let s = state([makeTask("tsk_a", { status: "review" })]);
    s = applySimEvent(s, {
      type: "task_transition",
      task_id: "tsk_a",
      to: "ready",
    });
    expect(s.tasks[0]!.status).toBe("ready");
  });

  it("supports integrate conflict branch", () => {
    let s = state([makeTask("tsk_a", { status: "integrating" })]);
    s = applySimEvent(s, {
      type: "task_transition",
      task_id: "tsk_a",
      to: "blocked",
      options: { blocked_reason: "integrate_conflict" },
    });
    expect(s.tasks[0]!.blocked_reason).toBe("integrate_conflict");
    s = applySimEvent(s, {
      type: "task_transition",
      task_id: "tsk_a",
      to: "integrating",
    });
    s = applySimEvent(s, {
      type: "task_transition",
      task_id: "tsk_a",
      to: "done",
    });
    expect(s.tasks[0]!.status).toBe("done");
  });

  it("does not stamp QA when open work remains after max_ticks", () => {
    const s0 = state(
      [makeTask("tsk_stuck", { status: "blocked", blocked_reason: "human" })],
      { feature_tip_sha: "tip0", qa: undefined },
    );
    const s = simulateImplementingToExit(s0, { max_ticks: 3 });
    expect(s.run.phase).toBe("Implementing");
    expect(s.tasks[0]!.status).toBe("blocked");
    expect(s.run.qa).toBeUndefined();
  });
});
