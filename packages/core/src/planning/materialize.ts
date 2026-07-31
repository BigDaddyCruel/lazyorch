import { createHash } from "node:crypto";
import { generateId } from "@lazyorch/shared";
import { SCHEMA_VERSION } from "../schema.js";
import type { Plan, PlanIssue } from "../types/plan.js";
import type { Task } from "../types/task.js";
import type { PlanArtifacts, PlanTaskDraft } from "./types.js";

/**
 * Materialize plan-origin Task records from TASK_DAG drafts.
 * All start as `todo`; scheduler promotes roots via readyWhenDepsDone.
 */
export function materializePlanTasks(
  runId: string,
  drafts: readonly PlanTaskDraft[],
): Task[] {
  return drafts.map((d) => {
    const task: Task = {
      id: d.id,
      run_id: runId,
      title: d.title,
      description: d.description,
      status: "todo",
      origin: "plan",
      priority: d.priority ?? 2,
      depends_on: [...d.depends_on],
      role_affinity: [...d.role_affinity],
      scope: [...d.scope],
      acceptance: [...d.acceptance],
      review_criteria: d.review_criteria ? [...d.review_criteria] : [],
      workspace_mode: d.workspace_mode ?? "worktree",
      attempt: 0,
      max_attempts: 3,
      artifacts: [],
    };
    return task;
  });
}

/** Canonical JSON for freeze hash (stable key order for task fields). */
export function freezePayload(artifacts: PlanArtifacts, issues: readonly PlanIssue[]): string {
  return JSON.stringify({
    design_md: artifacts.design_md,
    key_decisions_md: artifacts.key_decisions_md ?? null,
    pr_plan_md: artifacts.pr_plan_md,
    task_dag: {
      tasks: artifacts.task_dag.tasks.map((t) => ({
        id: t.id,
        title: t.title,
        description: t.description,
        depends_on: t.depends_on,
        role_affinity: t.role_affinity,
        scope: t.scope,
        acceptance: t.acceptance,
        review_criteria: t.review_criteria ?? [],
        priority: t.priority ?? 2,
        workspace_mode: t.workspace_mode ?? "worktree",
        plan_estimate_tier: t.plan_estimate_tier ?? null,
      })),
      meta: artifacts.task_dag.meta ?? null,
    },
    issues: issues.map((i) => ({
      id: i.id,
      severity: i.severity,
      category: i.category,
      section: i.section,
      description: i.description,
      status: i.status,
      response: i.response ?? null,
    })),
  });
}

/** SHA-256 hex of freeze payload (immutable contract id). */
export function computeFreezeHash(
  artifacts: PlanArtifacts,
  issues: readonly PlanIssue[],
): string {
  return createHash("sha256")
    .update(freezePayload(artifacts, issues), "utf8")
    .digest("hex");
}

export interface BuildPlanOptions {
  id?: string;
  run_id: string;
  revision: number;
  status: Plan["status"];
  issues: PlanIssue[];
  task_ids: string[];
  created_at?: string;
  updated_at?: string;
  freeze_hash?: string;
  frozen_at?: string;
  residual_risks?: string[];
}

export function buildPlan(options: BuildPlanOptions): Plan {
  const now = options.updated_at ?? new Date().toISOString();
  const plan: Plan = {
    schema_version: SCHEMA_VERSION,
    id: options.id ?? generateId("plan"),
    run_id: options.run_id,
    revision: options.revision,
    status: options.status,
    issues: options.issues,
    task_ids: options.task_ids,
    created_at: options.created_at ?? now,
    updated_at: now,
  };
  if (options.freeze_hash !== undefined) {
    plan.freeze_hash = options.freeze_hash;
  }
  if (options.frozen_at !== undefined) {
    plan.frozen_at = options.frozen_at;
  }
  if (options.residual_risks !== undefined) {
    plan.residual_risks = options.residual_risks;
  }
  return plan;
}
