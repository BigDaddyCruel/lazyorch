/**
 * Ephemeral review / QA / lead session policy (KD-26, KD-35).
 *
 * All agent roles use ephemeral sessions in v1. Idle agent configs hold zero slots.
 * Reviewer must not idle > reviewer.idle_exit_ms (default 60s).
 */

import type { AgentRole } from "../types/agent.js";
import type { Task } from "../types/task.js";
import type { EphemeralSessionPolicy } from "./types.js";

export const DEFAULT_REVIEWER_IDLE_EXIT_MS = 60_000;
export const DEFAULT_REVIEWER_MAX_RESTARTS_PER_HOUR = 6;
export const DEFAULT_QA_MAX_RESTARTS_PER_HOUR = 6;
export const DEFAULT_LEAD_MAX_RESTARTS_PER_HOUR = 3;
/** Lead/QA default idle exit when queue empty (same spirit as reviewer). */
export const DEFAULT_LEAD_IDLE_EXIT_MS = 60_000;
export const DEFAULT_QA_IDLE_EXIT_MS = 60_000;

export function defaultEphemeralPolicy(
  role: "lead" | "reviewer" | "qa",
  overrides?: Partial<EphemeralSessionPolicy>,
): EphemeralSessionPolicy {
  const base: EphemeralSessionPolicy = (() => {
    switch (role) {
      case "reviewer":
        return {
          mode: "ephemeral",
          idle_exit_ms: DEFAULT_REVIEWER_IDLE_EXIT_MS,
          max_restarts_per_hour: DEFAULT_REVIEWER_MAX_RESTARTS_PER_HOUR,
        };
      case "qa":
        return {
          mode: "ephemeral",
          idle_exit_ms: DEFAULT_QA_IDLE_EXIT_MS,
          max_restarts_per_hour: DEFAULT_QA_MAX_RESTARTS_PER_HOUR,
        };
      case "lead":
        return {
          mode: "ephemeral",
          idle_exit_ms: DEFAULT_LEAD_IDLE_EXIT_MS,
          max_restarts_per_hour: DEFAULT_LEAD_MAX_RESTARTS_PER_HOUR,
        };
    }
  })();
  return {
    mode: "ephemeral",
    idle_exit_ms: overrides?.idle_exit_ms ?? base.idle_exit_ms,
    max_restarts_per_hour:
      overrides?.max_restarts_per_hour ?? base.max_restarts_per_hour,
  };
}

export interface IdleExitInput {
  role: AgentRole;
  /** Last activity timestamp (ms). */
  last_activity_ms: number;
  now_ms: number;
  idle_exit_ms: number;
  /** Session still has assigned work (task in progress for this session). */
  has_assigned_work: boolean;
  /**
   * Global queue empty for this role:
   * - reviewer: no tasks in review / needs_re_review
   * - qa: no pending QA jobs
   * - lead: no lead agent work pending
   */
  global_queue_empty: boolean;
}

/**
 * Whether an ephemeral session should clean-exit for idle.
 * Clean exit does not count toward max_restarts_per_hour.
 *
 * Rules:
 * - Never exit while has_assigned_work
 * - Exit when global_queue_empty and idle ≥ idle_exit_ms
 * - Reviewer may also exit when global_queue_empty immediately after batch
 *   (idle_exit_ms still required unless idle_exit_ms === 0)
 */
export function shouldIdleExitEphemeral(input: IdleExitInput): boolean {
  if (input.has_assigned_work) return false;
  if (!input.global_queue_empty) return false;
  const idle = input.now_ms - input.last_activity_ms;
  return idle >= input.idle_exit_ms;
}

/** Tasks waiting for a reviewer session. */
export function reviewQueueTasks(tasks: readonly Task[]): Task[] {
  return tasks.filter(
    (t) =>
      t.status === "review" ||
      (t.status === "in_progress" && t.needs_re_review === true),
  );
}

export interface CanStartReviewerInput {
  /** Tasks in review (or needs_re_review). */
  review_queue_count: number;
  active_reviewers: number;
  max_reviewers: number;
  free_slots: number;
  /** Solo / zero max → never start. */
  mode_allows: boolean;
}

/** Start reviewer when queue non-empty, under caps, free slots (after lead priority). */
export function canStartReviewerSession(input: CanStartReviewerInput): boolean {
  if (!input.mode_allows) return false;
  if (input.review_queue_count < 1) return false;
  if (input.active_reviewers >= input.max_reviewers) return false;
  if (input.free_slots < 1) return false;
  return true;
}

export interface CanStartQaInput {
  qa_work_pending: boolean;
  active_qa: number;
  max_qa: number;
  free_slots: number;
  mode_allows: boolean;
}

export function canStartQaSession(input: CanStartQaInput): boolean {
  if (!input.mode_allows) return false;
  if (!input.qa_work_pending) return false;
  if (input.active_qa >= input.max_qa) return false;
  if (input.free_slots < 1) return false;
  return true;
}

/**
 * Restart budget: true when countable crash exits in the last hour are still
 * within the allowed max restarts (inclusive).
 *
 * Semantics: `max_restarts_per_hour = N` means **N restarts allowed** after
 * crashes. After the Nth countable exit, `restarts_last_hour === N` still
 * allows a restart; the (N+1)th exit exhausts the budget.
 *
 * `max = 0` → never restart after a crash (`1 <= 0` is false).
 */
export function withinRestartBudget(
  restarts_last_hour: number,
  max_restarts_per_hour: number,
): boolean {
  return restarts_last_hour <= max_restarts_per_hour;
}
