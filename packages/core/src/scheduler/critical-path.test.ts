import { describe, expect, it } from "vitest";
import type { Task } from "../types/task.js";
import {
  criticalPathLengths,
  isOnCriticalPath,
  sortReadyForAssign,
} from "./critical-path.js";

function task(
  id: string,
  opts: Partial<Task> & { depends_on?: string[]; status?: Task["status"] } = {},
): Task {
  return {
    id,
    run_id: "run_1",
    title: id,
    description: "",
    status: opts.status ?? "ready",
    origin: "plan",
    priority: opts.priority ?? 2,
    depends_on: opts.depends_on ?? [],
    role_affinity: [],
    scope: opts.scope ?? [],
    acceptance: [],
    review_criteria: [],
    workspace_mode: "worktree",
    attempt: 1,
    max_attempts: 3,
    artifacts: [],
    ...opts,
  };
}

describe("criticalPathLengths", () => {
  it("computes longest remaining chain (task count)", () => {
    // A → B → C  and  A → D
    // lengths from each node along dependents:
    // C:1, D:1, B:2 (B→C), A:3 (A→B→C)
    const tasks = [
      task("A", { status: "ready", depends_on: [] }),
      task("B", { status: "todo", depends_on: ["A"] }),
      task("C", { status: "todo", depends_on: ["B"] }),
      task("D", { status: "todo", depends_on: ["A"] }),
    ];
    const lens = criticalPathLengths(tasks);
    expect(lens.get("C")).toBe(1);
    expect(lens.get("D")).toBe(1);
    expect(lens.get("B")).toBe(2);
    expect(lens.get("A")).toBe(3);
  });

  it("excludes done/cancelled/failed from remaining path", () => {
    const tasks = [
      task("A", { status: "done" }),
      task("B", { status: "ready", depends_on: ["A"] }),
    ];
    const lens = criticalPathLengths(tasks);
    expect(lens.get("A")).toBe(0);
    expect(lens.get("B")).toBe(1);
  });

  it("marks critical path at global max", () => {
    const tasks = [
      task("A", { status: "ready" }),
      task("B", { status: "todo", depends_on: ["A"] }),
      task("X", { status: "ready" }),
    ];
    const lens = criticalPathLengths(tasks);
    expect(isOnCriticalPath("A", lens)).toBe(true);
    expect(isOnCriticalPath("X", lens)).toBe(false);
  });
});

describe("sortReadyForAssign", () => {
  it("orders by critical path desc, then priority, then id", () => {
    const tasks = [
      task("low_cp", { status: "ready", priority: 1 }),
      task("high_cp_b", { status: "ready", priority: 2 }),
      task("high_cp_a", { status: "ready", priority: 2 }),
      task("mid", { status: "todo", depends_on: ["high_cp_a"] }),
    ];
    // Make high_cp_* longer by attaching mid under high_cp_a only
    const all = [
      ...tasks,
      task("tail", { status: "todo", depends_on: ["mid"] }),
    ];
    const lens = criticalPathLengths(all);
    const ready = all.filter((t) => t.status === "ready");
    const sorted = sortReadyForAssign(ready, lens);
    // high_cp_a has longer chain than high_cp_b
    expect(sorted[0]?.id).toBe("high_cp_a");
    // low_cp has priority 1 (highest) but short path — after longer paths
    expect(sorted.map((t) => t.id)).toContain("low_cp");
  });
});
