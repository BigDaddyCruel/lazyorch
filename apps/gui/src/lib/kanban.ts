import type { BoardTask, TaskStatus } from "../api/types.js";
import { TASK_STATUSES } from "../api/types.js";

/** Kanban columns shown on the run board (left → right workflow). */
export const KANBAN_COLUMNS: readonly TaskStatus[] = [
  "todo",
  "ready",
  "in_progress",
  "review",
  "integrating",
  "blocked",
  "done",
  "failed",
  "cancelled",
] as const;

export const KANBAN_COLUMN_LABELS: Record<TaskStatus, string> = {
  todo: "Todo",
  ready: "Ready",
  in_progress: "In progress",
  review: "Review",
  integrating: "Integrating",
  blocked: "Blocked",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

export type KanbanBoard = Record<TaskStatus, BoardTask[]>;

/** Group tasks into kanban columns; unknown statuses land in todo. */
export function groupTasksByStatus(tasks: readonly BoardTask[]): KanbanBoard {
  const board = emptyKanban();
  for (const task of tasks) {
    const status = isTaskStatus(task.status) ? task.status : "todo";
    board[status].push(task);
  }
  // Stable priority sort within columns (1 highest)
  for (const col of TASK_STATUSES) {
    board[col].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  }
  return board;
}

export function emptyKanban(): KanbanBoard {
  const board = {} as KanbanBoard;
  for (const s of TASK_STATUSES) {
    board[s] = [];
  }
  return board;
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}

export function countActiveTasks(tasks: readonly BoardTask[]): number {
  return tasks.filter(
    (t) => t.status !== "done" && t.status !== "cancelled" && t.status !== "failed",
  ).length;
}

export function taskProgress(tasks: readonly BoardTask[]): {
  total: number;
  done: number;
  failed: number;
  active: number;
  pct: number;
} {
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === "done").length;
  const failed = tasks.filter((t) => t.status === "failed").length;
  const active = countActiveTasks(tasks);
  const denom = total === 0 ? 1 : total;
  const pct = Math.round((done / denom) * 100);
  return { total, done, failed, active, pct };
}
