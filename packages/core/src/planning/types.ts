import type { ModelTier } from "../types/model-tier.js";
import type { Plan, PlanIssue } from "../types/plan.js";
import type { Task, TaskPriority, WorkspaceMode } from "../types/task.js";

/**
 * Plan-origin task draft as written into TASK_DAG.json.
 * Materialized into runtime {@link Task} on freeze.
 */
export interface PlanTaskDraft {
  id: string;
  title: string;
  description: string;
  depends_on: string[];
  role_affinity: string[];
  /** Git path globs for scope locks */
  scope: string[];
  acceptance: string[];
  review_criteria?: string[];
  priority?: TaskPriority;
  workspace_mode?: WorkspaceMode;
  plan_estimate_tier?: ModelTier;
}

/** Declared scope overlap between plan tasks (lock-annotated). */
export interface OverlappingScope {
  /** Task ids that intentionally share paths */
  task_ids: string[];
  /** Paths / globs that overlap (optional documentation) */
  paths?: string[];
  note?: string;
}

export interface TaskDagMeta {
  overlapping_scopes?: OverlappingScope[];
}

/** TASK_DAG artifact shape. */
export interface TaskDag {
  tasks: PlanTaskDraft[];
  meta?: TaskDagMeta;
}

/** Plan document set produced by the writer each revision. */
export interface PlanArtifacts {
  design_md: string;
  task_dag: TaskDag;
  pr_plan_md: string;
  /** Optional standalone KEY_DECISIONS.md (otherwise section in design_md). */
  key_decisions_md?: string;
}

/** Writer response that resolves a review issue. */
export interface IssueUpdate {
  issue_id: string;
  status: "addressed" | "wontfix";
  response: string;
}

export interface PlanWriteContext {
  idea: string;
  run_id: string;
  revision: number;
  /** Prior revision artifacts when revising */
  previous?: PlanArtifacts;
  /** Blocking issues the writer must address */
  open_issues: PlanIssue[];
  /**
   * Freeze validator failures from the previous revision (0 open issues but
   * freeze still rejected — missing sections, scope overlaps, etc.).
   */
  validation_errors?: FreezeValidationError[];
  /** Prior frozen plan when mid-run replan */
  prior_plan?: Plan;
}

export interface PlanWriteResult {
  artifacts: PlanArtifacts;
  /** Status transitions applied after write (response required). */
  issue_updates?: IssueUpdate[];
}

export interface PlanReviewContext {
  idea: string;
  run_id: string;
  revision: number;
  artifacts: PlanArtifacts;
  /** Issues from previous rounds (may be re-opened). */
  previous_issues: PlanIssue[];
}

export interface PlanReviewResult {
  /**
   * Full issue set for this revision (open + addressed + wontfix + needs-user-input).
   * Reviewer may re-open previously addressed issues.
   */
  issues: PlanIssue[];
}

/** Options for freeze validators (mirrors planning config knobs). */
export interface FreezeValidatorOptions {
  /** Default 524_288 (512 KiB). */
  max_design_bytes?: number;
  /** When true (default), undeclared scope overlaps are errors. */
  strict_scopes?: boolean;
  /**
   * Required DESIGN.md section headings (case-insensitive: heading must
   * contain the required string). Defaults to design-doc list.
   */
  required_sections?: readonly string[];
}

export type FreezeValidationCode =
  | "empty_dag"
  | "cycle"
  | "missing_dep"
  | "duplicate_id"
  | "empty_id"
  | "invalid_depends_on"
  | "empty_title"
  | "empty_description"
  | "empty_acceptance"
  | "empty_scope"
  | "empty_role_affinity"
  | "missing_section"
  | "design_too_large"
  | "open_issues"
  | "pr_plan_coverage"
  | "scope_overlap";

export interface FreezeValidationError {
  code: FreezeValidationCode;
  message: string;
  /** Task id, section name, or issue id when applicable. */
  path?: string;
}

export interface FreezeValidationResult {
  ok: boolean;
  errors: FreezeValidationError[];
}

export interface FreezeInput {
  artifacts: PlanArtifacts;
  issues: readonly PlanIssue[];
  options?: FreezeValidatorOptions;
}

/** Successful freeze payload. */
export interface FrozenPlanResult {
  status: "frozen";
  plan: Plan;
  artifacts: PlanArtifacts;
  tasks: Task[];
  rounds: number;
  freeze_hash: string;
}

/** Rounds exhausted with residual open issues or validator failures. */
export interface MaxRoundsResult {
  status: "max_rounds";
  plan: Plan;
  artifacts: PlanArtifacts;
  tasks: Task[];
  rounds: number;
  open_issues: number;
  validation_errors: FreezeValidationError[];
}

/**
 * Writer marked wontfix; reviewer re-opened same issue at high/critical
 * (design dispute escalation — blocks freeze until plan_dispute gate).
 */
export interface DisputeResult {
  status: "dispute";
  plan: Plan;
  artifacts: PlanArtifacts;
  tasks: Task[];
  rounds: number;
  disputed_issue_ids: string[];
}

export type ConsensusResult =
  | FrozenPlanResult
  | MaxRoundsResult
  | DisputeResult;

export interface ConsensusConfig {
  /** Default 5. */
  max_rounds: number;
  max_design_bytes: number;
  strict_scopes: boolean;
  required_sections?: readonly string[];
}
