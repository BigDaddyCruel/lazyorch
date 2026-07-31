import type { ModelTier } from "./model-tier.js";

export const TASK_STATUSES = [
  "todo",
  "ready",
  "in_progress",
  "review",
  "integrating",
  "done",
  "failed",
  "cancelled",
  "blocked",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

const STATUS_SET = new Set<string>(TASK_STATUSES);

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && STATUS_SET.has(value);
}

export type TaskOrigin = "plan" | "dynamic";

export type TaskPriority = 1 | 2 | 3 | 4;

export type WorkspaceMode = "worktree" | "shared" | "isolated";

export type BlockedReason =
  | "scope_lock"
  | "human"
  | "dependency"
  | "resource"
  | "integrate_conflict";

/**
 * Executable unit under a run. ID: `tsk_…`
 * Review/integration happen inside Implementing; not exclusive run phases.
 */
export interface Task {
  id: string;
  run_id: string;
  title: string;
  description: string;
  status: TaskStatus;
  origin: TaskOrigin;
  /** 1 = highest, 4 = lowest */
  priority: TaskPriority;
  depends_on: string[];
  role_affinity: string[];
  /** Git path globs for scope locks */
  scope: string[];
  acceptance: string[];
  review_criteria: string[];
  workspace_mode: WorkspaceMode;
  attempt: number;
  max_attempts: number;
  artifacts: string[];
  assignee?: string;
  worktree_path?: string;
  branch?: string;
  blocked_reason?: BlockedReason;
  integrate_error?: string;
  needs_re_review?: boolean;
  superseded_by_plan?: string;
  tier_override?: ModelTier;
  model_override?: string;
  adapter_override?: string;
  complexity_score?: number;
  last_model_tier?: ModelTier;
  last_adapter_id?: string;
  last_model_id?: string;
}

/** Minimal shape for DAG algorithms (id + depends_on). */
export interface TaskNode {
  id: string;
  depends_on: string[];
}
