import { describe, expect, it } from "vitest";
import type { Task, TaskStatus } from "../types/task.js";
import {
  canTransitionTaskStatus,
  isTerminalTaskStatus,
  TaskFsmError,
  transitionTaskStatus,
} from "./task-fsm.js";

function task(status: TaskStatus, overrides: Partial<Task> = {}): Task {
  return {
    id: "tsk_1",
    run_id: "run_1",
    title: "Do work",
    description: "…",
    status,
    origin: "plan",
    priority: 2,
    depends_on: [],
    role_affinity: ["worker"],
    scope: ["src/**"],
    acceptance: ["tests pass"],
    review_criteria: ["typecheck"],
    workspace_mode: "worktree",
    attempt: 0,
    max_attempts: 3,
    artifacts: [],
    ...overrides,
  };
}

describe("task FSM", () => {
  it("allows main path todo → … → done", () => {
    const path: TaskStatus[] = [
      "todo",
      "ready",
      "in_progress",
      "review",
      "integrating",
      "done",
    ];
    let t = task("todo");
    for (let i = 1; i < path.length; i++) {
      expect(canTransitionTaskStatus(path[i - 1]!, path[i]!)).toBe(true);
      t = transitionTaskStatus(t, path[i]!);
      expect(t.status).toBe(path[i]);
    }
    expect(isTerminalTaskStatus(t.status)).toBe(true);
  });

  it("allows review → ready on reject", () => {
    const t = transitionTaskStatus(task("review"), "ready");
    expect(t.status).toBe("ready");
  });

  it("allows integrating → blocked with integrate_conflict default", () => {
    const t = transitionTaskStatus(task("integrating"), "blocked");
    expect(t.status).toBe("blocked");
    expect(t.blocked_reason).toBe("integrate_conflict");
  });

  it("allows blocked → integrating after clean rebase", () => {
    const blocked = transitionTaskStatus(task("integrating"), "blocked", {
      blocked_reason: "integrate_conflict",
    });
    const again = transitionTaskStatus(blocked, "integrating");
    expect(again.status).toBe("integrating");
    expect(again.blocked_reason).toBeUndefined();
  });

  it("allows blocked → ready when reason cleared", () => {
    const t = transitionTaskStatus(
      task("blocked", { blocked_reason: "scope_lock" }),
      "ready",
    );
    expect(t.status).toBe("ready");
    expect(t.blocked_reason).toBeUndefined();
  });

  it("increments attempt on failed → ready retry", () => {
    const t = transitionTaskStatus(task("failed", { attempt: 1 }), "ready");
    expect(t.status).toBe("ready");
    expect(t.attempt).toBe(2);
  });

  it("rejects illegal edges", () => {
    expect(canTransitionTaskStatus("todo", "done")).toBe(false);
    expect(canTransitionTaskStatus("done", "ready")).toBe(false);
    expect(canTransitionTaskStatus("review", "in_progress")).toBe(false);
    expect(() => transitionTaskStatus(task("todo"), "done")).toThrow(
      TaskFsmError,
    );
    try {
      transitionTaskStatus(task("cancelled"), "ready");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TaskFsmError);
      expect((e as TaskFsmError).code).toBe("terminal");
    }
  });

  it("allows cancel from active states", () => {
    for (const s of [
      "todo",
      "ready",
      "in_progress",
      "review",
      "integrating",
      "blocked",
      "failed",
    ] as const) {
      expect(canTransitionTaskStatus(s, "cancelled")).toBe(true);
    }
  });
});
