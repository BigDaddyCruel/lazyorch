import type { BlockedReason, Task, TaskStatus } from "../types/task.js";

export class TaskFsmError extends Error {
  readonly code: "invalid_transition" | "terminal";

  constructor(code: TaskFsmError["code"], message: string) {
    super(message);
    this.name = "TaskFsmError";
    this.code = code;
  }
}

/**
 * Allowed task status transitions (design-lazyorch task FSM).
 *
 * Main path: todo → ready → in_progress → review → integrating → done
 * Branches: blocked, failed, cancelled; review→ready on reject;
 * integrating→blocked on integrate_conflict; failed→ready on retry.
 */
const ALLOWED: ReadonlyMap<TaskStatus, ReadonlySet<TaskStatus>> = new Map<
  TaskStatus,
  ReadonlySet<TaskStatus>
>([
  ["todo", new Set<TaskStatus>(["ready", "cancelled"])],
  ["ready", new Set<TaskStatus>(["in_progress", "blocked", "cancelled"])],
  [
    "in_progress",
    new Set<TaskStatus>(["review", "failed", "cancelled", "blocked"]),
  ],
  ["review", new Set<TaskStatus>(["integrating", "ready", "failed", "cancelled"])],
  [
    "integrating",
    new Set<TaskStatus>(["done", "blocked", "failed", "cancelled"]),
  ],
  [
    "blocked",
    new Set<TaskStatus>(["ready", "integrating", "cancelled", "failed"]),
  ],
  ["failed", new Set<TaskStatus>(["ready", "cancelled"])],
  ["done", new Set<TaskStatus>()],
  ["cancelled", new Set<TaskStatus>()],
]);

const TERMINALS: ReadonlySet<TaskStatus> = new Set(["done", "cancelled"]);

/** Statuses that keep Implementing open (not terminal success/cancel). */
export const OPEN_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "todo",
  "ready",
  "in_progress",
  "review",
  "integrating",
  "blocked",
  "failed",
]);

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINALS.has(status);
}

export function canTransitionTaskStatus(
  from: TaskStatus,
  to: TaskStatus,
): boolean {
  return ALLOWED.get(from)?.has(to) ?? false;
}

export function allowedTaskTransitions(
  from: TaskStatus,
): readonly TaskStatus[] {
  return [...(ALLOWED.get(from) ?? [])];
}

export interface TransitionTaskOptions {
  blocked_reason?: BlockedReason;
  integrate_error?: string;
  /** When moving failed → ready (retry), increment attempt */
  increment_attempt?: boolean;
  assignee?: string;
  worktree_path?: string;
  branch?: string;
  needs_re_review?: boolean;
  clear_blocked?: boolean;
  clear_integrate_error?: boolean;
}

/**
 * Apply a task status transition (pure; returns a new Task).
 * Throws TaskFsmError on illegal edges.
 */
export function transitionTaskStatus(
  task: Task,
  to: TaskStatus,
  options: TransitionTaskOptions = {},
): Task {
  if (!canTransitionTaskStatus(task.status, to)) {
    throw new TaskFsmError(
      isTerminalTaskStatus(task.status) ? "terminal" : "invalid_transition",
      `Cannot transition task ${task.id} from ${task.status} to ${to}`,
    );
  }

  const next: Task = {
    ...task,
    status: to,
  };

  if (to === "blocked") {
    if (options.blocked_reason !== undefined) {
      next.blocked_reason = options.blocked_reason;
    }
    if (options.integrate_error !== undefined) {
      next.integrate_error = options.integrate_error;
    }
  }

  if (options.clear_blocked || to === "ready" || to === "integrating") {
    if (to !== "blocked") {
      delete next.blocked_reason;
    }
  }
  if (options.clear_integrate_error || to === "done") {
    delete next.integrate_error;
  }

  if (options.assignee !== undefined) next.assignee = options.assignee;
  if (options.worktree_path !== undefined) {
    next.worktree_path = options.worktree_path;
  }
  if (options.branch !== undefined) next.branch = options.branch;
  if (options.needs_re_review !== undefined) {
    next.needs_re_review = options.needs_re_review;
  }

  if (options.increment_attempt || (task.status === "failed" && to === "ready")) {
    next.attempt = task.attempt + 1;
  }

  // integrating → blocked with integrate_conflict is the v1 sole recovery path
  if (
    task.status === "integrating" &&
    to === "blocked" &&
    options.blocked_reason === undefined
  ) {
    next.blocked_reason = "integrate_conflict";
  }

  return next;
}
