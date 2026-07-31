import { describe, expect, it } from "vitest";
import {
  DagError,
  depsSatisfied,
  hasCycle,
  readyWhenDepsDone,
  topologicalSort,
} from "./dag.js";
import type { Task, TaskNode } from "./types/task.js";

function node(id: string, depends_on: string[] = []): TaskNode {
  return { id, depends_on };
}

function task(
  id: string,
  status: Task["status"],
  depends_on: string[] = [],
): Task {
  return {
    id,
    run_id: "run_x",
    title: id,
    description: "",
    status,
    origin: "plan",
    priority: 2,
    depends_on,
    role_affinity: ["worker"],
    scope: ["src/**"],
    acceptance: ["tests pass"],
    review_criteria: ["typecheck"],
    workspace_mode: "worktree",
    attempt: 0,
    max_attempts: 3,
    artifacts: [],
  };
}

describe("hasCycle", () => {
  it("returns false for a DAG", () => {
    const nodes = [node("a"), node("b", ["a"]), node("c", ["a", "b"])];
    expect(hasCycle(nodes)).toBe(false);
  });

  it("returns false for a diamond DAG", () => {
    // a → b → d, a → c → d
    const nodes = [
      node("a"),
      node("b", ["a"]),
      node("c", ["a"]),
      node("d", ["b", "c"]),
    ];
    expect(hasCycle(nodes)).toBe(false);
    expect(topologicalSort(nodes)).toEqual(["a", "b", "c", "d"]);
  });

  it("returns true for a simple cycle", () => {
    const nodes = [node("a", ["b"]), node("b", ["a"])];
    expect(hasCycle(nodes)).toBe(true);
  });

  it("returns true for a self-loop", () => {
    expect(hasCycle([node("a", ["a"])])).toBe(true);
    expect(() => topologicalSort([node("a", ["a"])])).toThrow(DagError);
  });

  it("returns true for a longer cycle", () => {
    const nodes = [
      node("a", ["c"]),
      node("b", ["a"]),
      node("c", ["b"]),
    ];
    expect(hasCycle(nodes)).toBe(true);
  });

  it("returns false for empty / single node", () => {
    expect(hasCycle([])).toBe(false);
    expect(hasCycle([node("only")])).toBe(false);
  });

  it("throws duplicate_id (same as topologicalSort)", () => {
    const dup = [node("a"), node("a")];
    expect(() => hasCycle(dup)).toThrow(DagError);
    expect(() => topologicalSort(dup)).toThrow(DagError);
    try {
      hasCycle(dup);
    } catch (e) {
      expect((e as DagError).code).toBe("duplicate_id");
    }
    try {
      topologicalSort(dup);
    } catch (e) {
      expect((e as DagError).code).toBe("duplicate_id");
    }
  });
});

describe("topologicalSort", () => {
  it("orders deps before dependents", () => {
    const nodes = [node("c", ["a", "b"]), node("b", ["a"]), node("a")];
    const order = topologicalSort(nodes);
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("c"));
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("c"));
  });

  it("throws on cycle", () => {
    expect(() => topologicalSort([node("a", ["b"]), node("b", ["a"])])).toThrow(
      DagError,
    );
    try {
      topologicalSort([node("a", ["b"]), node("b", ["a"])]);
    } catch (e) {
      expect(e).toBeInstanceOf(DagError);
      expect((e as DagError).code).toBe("cycle");
    }
  });

  it("throws on missing dependency", () => {
    expect(() => topologicalSort([node("a", ["missing"])])).toThrow(DagError);
    try {
      topologicalSort([node("a", ["missing"])]);
    } catch (e) {
      expect((e as DagError).code).toBe("missing_dep");
    }
  });

  it("throws on duplicate ids", () => {
    expect(() => topologicalSort([node("a"), node("a")])).toThrow(DagError);
  });
});

describe("readyWhenDepsDone", () => {
  it("returns todo tasks whose deps are done", () => {
    const tasks = [
      task("t1", "done"),
      task("t2", "todo", ["t1"]),
      task("t3", "todo", ["t2"]),
    ];
    const ready = readyWhenDepsDone(tasks);
    expect(ready.map((t) => t.id)).toEqual(["t2"]);
  });

  it("treats cancelled deps as satisfied", () => {
    const tasks = [task("t1", "cancelled"), task("t2", "todo", ["t1"])];
    expect(readyWhenDepsDone(tasks).map((t) => t.id)).toEqual(["t2"]);
  });

  it("excludes tasks that are already ready/in_progress", () => {
    const tasks = [task("t1", "done"), task("t2", "ready", ["t1"])];
    expect(readyWhenDepsDone(tasks)).toEqual([]);
  });

  it("excludes when any dep is not done-like", () => {
    const tasks = [
      task("t1", "in_progress"),
      task("t2", "todo", ["t1"]),
    ];
    expect(readyWhenDepsDone(tasks)).toEqual([]);
  });

  it("includes root todo tasks with no deps", () => {
    const tasks = [task("root", "todo")];
    expect(readyWhenDepsDone(tasks).map((t) => t.id)).toEqual(["root"]);
  });
});

describe("depsSatisfied", () => {
  it("works with a status map", () => {
    const map = new Map([
      ["a", { status: "done" as const }],
      ["b", { status: "failed" as const }],
    ]);
    expect(depsSatisfied(node("x", ["a"]), map)).toBe(true);
    expect(depsSatisfied(node("x", ["a", "b"]), map)).toBe(false);
  });
});
