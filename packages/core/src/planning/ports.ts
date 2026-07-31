import type {
  PlanReviewContext,
  PlanReviewResult,
  PlanWriteContext,
  PlanWriteResult,
} from "./types.js";

/**
 * Plan writer port — produces DESIGN + TASK_DAG + PR_PLAN (and issue responses).
 * Real adapters bind LLM sessions; tests use {@link FakePlanWriter}.
 */
export interface PlanWriterPort {
  write(ctx: PlanWriteContext): Promise<PlanWriteResult>;
}

/**
 * Plan reviewer port — checklist review returning structured PlanIssue[].
 * Real adapters bind LLM sessions; tests use {@link FakePlanReviewer}.
 */
export interface PlanReviewerPort {
  review(ctx: PlanReviewContext): Promise<PlanReviewResult>;
}
