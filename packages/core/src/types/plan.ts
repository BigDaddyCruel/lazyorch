import type { SchemaVersion } from "../schema.js";
import type { ModelTier } from "./model-tier.js";

export const ISSUE_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];

export const ISSUE_STATUSES = [
  "open",
  "addressed",
  "wontfix",
  "needs-user-input",
] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const ISSUE_CATEGORIES = [
  "correctness",
  "security",
  "scope",
  "feasibility",
  "completeness",
  "clarity",
  "other",
] as const;
export type IssueCategory = (typeof ISSUE_CATEGORIES)[number];

/**
 * Structured plan review finding. ID: `iss_…`
 */
export interface PlanIssue {
  id: string;
  severity: IssueSeverity;
  category: IssueCategory;
  section: string;
  description: string;
  /** Optional remediation hint from reviewer */
  suggestion?: string;
  status: IssueStatus;
  /** Required when status is addressed | wontfix */
  response?: string;
  raised_by: string;
  raised_at: string;
  updated_at: string;
}

export const PLAN_STATUSES = [
  "draft",
  "in_review",
  "frozen",
  "superseded",
] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/**
 * Design document + Key Decisions + task DAG metadata.
 * Artifacts live under `.lazyorch/plans/<run_id>/`.
 * ID: `plan_…`
 */
export interface Plan {
  schema_version: SchemaVersion;
  id: string;
  run_id: string;
  revision: number;
  status: PlanStatus;
  issues: PlanIssue[];
  /** Plan-origin task ids from TASK_DAG */
  task_ids: string[];
  created_at: string;
  updated_at: string;
  freeze_hash?: string;
  frozen_at?: string;
  /** Residual risks after force_approve, etc. */
  residual_risks?: string[];
}

/** Optional author hint on a TASK_DAG node (plan artifact, not runtime Task). */
export interface TaskDagNodeHint {
  id: string;
  depends_on: string[];
  plan_estimate_tier?: ModelTier;
}
