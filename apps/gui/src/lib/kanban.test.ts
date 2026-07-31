import { describe, expect, it } from "vitest";
import type { BoardTask } from "../api/types.js";
import {
  countActiveTasks,
  groupTasksByStatus,
  taskProgress,
} from "./kanban.js";

function task(partial: Partial<BoardTask> & Pick<BoardTask, "id" | "status">): BoardTask {
  return {
    run_id: "run_1",
    title: partial.id,
    priority: 2,
    ...partial,
  };
}

describe("groupTasksByStatus", () => {
  it("buckets tasks and sorts by priority then id", () => {
    const board = groupTasksByStatus([
      task({ id: "b", status: "ready", priority: 2 }),
      task({ id: "a", status: "ready", priority: 1 }),
      task({ id: "c", status: "in_progress", priority: 1 }),
      task({ id: "d", status: "done", priority: 3 }),
    ]);
    expect(board.ready.map((t) => t.id)).toEqual(["a", "b"]);
    expect(board.in_progress.map((t) => t.id)).toEqual(["c"]);
    expect(board.done.map((t) => t.id)).toEqual(["d"]);
    expect(board.todo).toEqual([]);
  });

  it("maps unknown status to todo", () => {
    const board = groupTasksByStatus([
      task({ id: "x", status: "weird" as BoardTask["status"] }),
    ]);
    expect(board.todo.map((t) => t.id)).toEqual(["x"]);
  });
});

describe("taskProgress", () => {
  it("computes active and pct", () => {
    const tasks = [
      task({ id: "1", status: "done" }),
      task({ id: "2", status: "done" }),
      task({ id: "3", status: "in_progress" }),
      task({ id: "4", status: "failed" }),
    ];
    expect(countActiveTasks(tasks)).toBe(1);
    expect(taskProgress(tasks)).toEqual({
      total: 4,
      done: 2,
      failed: 1,
      active: 1,
      pct: 50,
    });
  });

  it("handles empty list", () => {
    expect(taskProgress([])).toEqual({
      total: 0,
      done: 0,
      failed: 0,
      active: 0,
      pct: 0,
    });
  });
});
