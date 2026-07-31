/**
 * Critical-path length in the remaining task DAG (task count, not hours).
 *
 * Remaining statuses: todo | ready | in_progress | review | integrating | blocked
 * Terminal done/cancelled/failed are excluded from the path.
 *
 * `critical_path_len(task)` = 1 + max(critical_path_len(dependents remaining))
 * measured along outgoing edges (longest chain of remaining work from this node).
 * Tasks with no remaining dependents have length 1.
 */

import type { Task, TaskStatus } from "../types/task.js";

/** Statuses that still count as remaining work on the critical path. */
export const REMAINING_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "todo",
  "ready",
  "in_progress",
  "review",
  "integrating",
  "blocked",
]);

export function isRemainingStatus(status: TaskStatus): boolean {
  return REMAINING_STATUSES.has(status);
}

/**
 * Compute longest remaining path length (in tasks) starting at each task id.
 * Only remaining-status tasks are included; others get length 0.
 *
 * Graph edges: dependency A → B means B depends on A (A must finish first).
 * Path length walks **forward** from a node to tasks that depend on it
 * (how much remaining work is gated by this task).
 */
export function criticalPathLengths(
  tasks: readonly Task[],
): Map<string, number> {
  const remaining = tasks.filter((t) => isRemainingStatus(t.status));
  const ids = new Set(remaining.map((t) => t.id));

  // dependents[dep] = tasks that list dep in depends_on
  const dependents = new Map<string, string[]>();
  for (const id of ids) dependents.set(id, []);
  for (const t of remaining) {
    for (const dep of t.depends_on) {
      if (!ids.has(dep)) continue;
      dependents.get(dep)!.push(t.id);
    }
  }

  const memo = new Map<string, number>();
  const visiting = new Set<string>();

  const dfs = (id: string): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) {
      // Cycle guard — treat as single node (DAG validators should prevent)
      return 1;
    }
    visiting.add(id);
    let best = 0;
    for (const child of dependents.get(id) ?? []) {
      best = Math.max(best, dfs(child));
    }
    visiting.delete(id);
    const len = 1 + best;
    memo.set(id, len);
    return len;
  };

  const out = new Map<string, number>();
  for (const t of tasks) {
    if (!ids.has(t.id)) {
      out.set(t.id, 0);
    } else {
      out.set(t.id, dfs(t.id));
    }
  }
  return out;
}

/** True if task sits on a longest remaining path (len === global max, max > 0). */
export function isOnCriticalPath(
  taskId: string,
  lengths: ReadonlyMap<string, number>,
): boolean {
  let max = 0;
  for (const v of lengths.values()) {
    if (v > max) max = v;
  }
  if (max <= 0) return false;
  return (lengths.get(taskId) ?? 0) === max;
}

/**
 * Sort ready tasks for assignment priority:
 * 1. Critical-path length (desc)
 * 2. Priority (1 highest → 4 lowest)
 * 3. Task id (asc, deterministic)
 */
export function sortReadyForAssign(
  ready: readonly Task[],
  lengths: ReadonlyMap<string, number>,
): Task[] {
  return [...ready].sort((a, b) => {
    const la = lengths.get(a.id) ?? 0;
    const lb = lengths.get(b.id) ?? 0;
    if (la !== lb) return lb - la;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
