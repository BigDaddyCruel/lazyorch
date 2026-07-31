import type { Task, TaskNode, TaskStatus } from "./types/task.js";

export class DagError extends Error {
  readonly code: "cycle" | "missing_dep" | "duplicate_id";

  constructor(code: DagError["code"], message: string) {
    super(message);
    this.name = "DagError";
    this.code = code;
  }
}

/** Statuses that count as “deps satisfied” for ready-when-deps-done. */
const DONE_LIKE: ReadonlySet<TaskStatus> = new Set(["done", "cancelled"]);

/**
 * Detect whether the dependency graph has a cycle.
 * Unknown depends_on targets are ignored for cycle detection (reported by topo sort).
 * Throws DagError(`duplicate_id`) if ids are not unique (same contract as topologicalSort).
 */
export function hasCycle(nodes: readonly TaskNode[]): boolean {
  const ids = new Set<string>();
  for (const n of nodes) {
    if (ids.has(n.id)) {
      throw new DagError("duplicate_id", `Duplicate task id: ${n.id}`);
    }
    ids.add(n.id);
  }

  const adj = new Map<string, string[]>();
  for (const n of nodes) {
    adj.set(
      n.id,
      n.depends_on.filter((d) => ids.has(d)),
    );
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of ids) color.set(id, WHITE);

  const visit = (u: string): boolean => {
    color.set(u, GRAY);
    for (const v of adj.get(u) ?? []) {
      const c = color.get(v) ?? WHITE;
      if (c === GRAY) return true;
      if (c === WHITE && visit(v)) return true;
    }
    color.set(u, BLACK);
    return false;
  };

  for (const id of ids) {
    if ((color.get(id) ?? WHITE) === WHITE && visit(id)) return true;
  }
  return false;
}

/**
 * Kahn topological sort. Throws DagError on cycles, duplicate ids, or missing deps.
 * Returns task ids in dependency order (deps before dependents).
 */
export function topologicalSort(nodes: readonly TaskNode[]): string[] {
  const byId = new Map<string, TaskNode>();
  for (const n of nodes) {
    if (byId.has(n.id)) {
      throw new DagError("duplicate_id", `Duplicate task id: ${n.id}`);
    }
    byId.set(n.id, n);
  }

  for (const n of nodes) {
    for (const dep of n.depends_on) {
      if (!byId.has(dep)) {
        throw new DagError(
          "missing_dep",
          `Task ${n.id} depends on missing id: ${dep}`,
        );
      }
    }
  }

  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const n of nodes) {
    indegree.set(n.id, 0);
    dependents.set(n.id, []);
  }
  for (const n of nodes) {
    for (const dep of n.depends_on) {
      indegree.set(n.id, (indegree.get(n.id) ?? 0) + 1);
      dependents.get(dep)!.push(n.id);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of indegree) {
    if (deg === 0) queue.push(id);
  }
  // Stable: sort queue for deterministic output when multiple roots
  queue.sort();

  const order: string[] = [];
  while (queue.length > 0) {
    // keep queue sorted for determinism
    queue.sort();
    const u = queue.shift()!;
    order.push(u);
    for (const v of dependents.get(u) ?? []) {
      const next = (indegree.get(v) ?? 0) - 1;
      indegree.set(v, next);
      if (next === 0) queue.push(v);
    }
  }

  if (order.length !== nodes.length) {
    throw new DagError("cycle", "Task dependency graph contains a cycle");
  }
  return order;
}

/**
 * Tasks that are `todo` (or optionally `blocked` with dependency reason cleared
 * is handled elsewhere) whose every depends_on is done or cancelled.
 * Returns tasks whose status is currently `todo` and deps are satisfied — candidates
 * to become `ready`.
 */
export function readyWhenDepsDone(
  tasks: readonly Task[],
): Task[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return tasks.filter((t) => {
    if (t.status !== "todo") return false;
    return t.depends_on.every((depId) => {
      const dep = byId.get(depId);
      if (!dep) return false;
      return DONE_LIKE.has(dep.status);
    });
  });
}

/** True if all depends_on for `task` are done or cancelled. */
export function depsSatisfied(
  task: TaskNode,
  tasksById: ReadonlyMap<string, Pick<Task, "status">>,
): boolean {
  return task.depends_on.every((depId) => {
    const dep = tasksById.get(depId);
    return dep !== undefined && DONE_LIKE.has(dep.status);
  });
}
