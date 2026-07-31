/**
 * Result → task FSM mapping hooks (KD-40).
 * Pure intents — scheduler applies transitions via core task FSM.
 */

import type { SessionResult, StructuredDecision } from "../types.js";

/** Target task statuses the runner may recommend. */
export type MappedTaskStatus =
  | "review"
  | "ready"
  | "failed"
  | "integrating"
  | "in_progress"
  | "cancelled";

/**
 * Known cancel reasons for session → task mapping.
 * - replan_supersede: keep task in_progress (replan owns the edge)
 * - run_cancel / budget_hard_stop / user: terminal cancel task
 * - preempt / other transient: requeue with attempt++
 */
export type CancelReason =
  | "replan_supersede"
  | "run_cancel"
  | "budget_hard_stop"
  | "user"
  | "preempt"
  | "cancel"
  | "cancel_all"
  | (string & {});

export type TaskFsmEffect =
  | {
      kind: "transition";
      to: MappedTaskStatus;
      increment_attempt?: boolean;
      reason: string;
    }
  | { kind: "stay"; status_hint?: MappedTaskStatus; reason: string }
  | { kind: "human_intervention"; reason: string }
  | { kind: "qa_pass"; summary?: string; reason: string }
  | { kind: "qa_fail"; summary?: string; reason: string }
  | { kind: "none"; reason: string };

export interface MapResultOptions {
  role: string;
  session_kind: "llm" | "deterministic";
  result: SessionResult;
  /** Consecutive invalid reviewer/QA parses for this task (0 = first). */
  invalid_parse_count?: number;
  /** Task attempt count before this session. */
  attempt?: number;
  max_attempts?: number;
  /**
   * Cancel reason when status is cancelled (from ManagedRunningAgent.cancel).
   * See mapCancelEffect for taxonomy.
   */
  cancel_reason?: CancelReason;
}

/** Terminal cancel reasons → task cancelled (no attempt++). */
const TERMINAL_CANCEL_REASONS = new Set([
  "run_cancel",
  "budget_hard_stop",
  "user",
]);

/**
 * Map cancel status + reason to a task FSM effect (shared by all roles with tasks).
 */
export function mapCancelEffect(
  cancel_reason: CancelReason | undefined,
  role: string,
): TaskFsmEffect {
  const reason = cancel_reason ?? "cancel";

  if (reason === "replan_supersede") {
    return {
      kind: "stay",
      status_hint: "in_progress",
      reason: "cancelled for replan supersede",
    };
  }

  if (TERMINAL_CANCEL_REASONS.has(reason)) {
    return {
      kind: "transition",
      to: "cancelled",
      reason: `${role} cancelled (${reason})`,
    };
  }

  // preempt, cancel, cancel_all, unknown → requeue (transient)
  return {
    kind: "transition",
    to: "ready",
    increment_attempt: true,
    reason: `${role} cancelled (${reason})`,
  };
}

/**
 * Map a finished SessionResult to a task FSM effect.
 * Does not mutate task state — caller applies via transitionTaskStatus.
 */
export function mapSessionResultToTaskEffect(
  options: MapResultOptions,
): TaskFsmEffect {
  const {
    role,
    result,
    invalid_parse_count = 0,
    attempt = 0,
    max_attempts = 3,
    cancel_reason,
  } = options;

  if (role === "lead") {
    return { kind: "none", reason: "lead session has no task edge" };
  }

  if (role === "plan_writer" || role === "plan_reviewer") {
    return {
      kind: "none",
      reason: "planning engine consumes plan artifacts (not task FSM)",
    };
  }

  // Cancel mapping is role-agnostic for workers; apply before role mappers
  // so replan_supersede / terminal reasons are never skipped (Issue 1 / 5).
  if (result.status === "cancelled" && role === "worker") {
    return mapCancelEffect(cancel_reason, "worker");
  }

  if (role === "worker") {
    return mapWorker(result, attempt, max_attempts);
  }

  if (role === "reviewer") {
    return mapReviewer(result, invalid_parse_count, cancel_reason);
  }

  if (role === "qa") {
    return mapQa(result, invalid_parse_count, cancel_reason);
  }

  // timeout / stall on any other role
  if (result.status === "timeout" || result.status === "stall") {
    return {
      kind: "transition",
      to: "ready",
      increment_attempt: true,
      reason: `session ${result.status}`,
    };
  }

  if (result.status === "cancelled") {
    return mapCancelEffect(cancel_reason, role);
  }

  return { kind: "none", reason: `no mapping for role ${role}` };
}

function mapWorker(
  result: SessionResult,
  attempt: number,
  max_attempts: number,
): TaskFsmEffect {
  // cancelled handled by caller via mapCancelEffect
  if (
    result.status === "timeout" ||
    result.status === "stall" ||
    result.status === "error"
  ) {
    return requeueOrFail(attempt, max_attempts, result.status);
  }

  const decision = result.decision;
  if (decision?.kind === "worker" && decision.submitted === false) {
    return requeueOrFail(attempt, max_attempts, "worker submitted: false");
  }

  // ok + submitted true, or ok + exit 0 without error marker
  if (result.status === "ok") {
    if (decision?.kind === "worker" && decision.submitted === true) {
      return {
        kind: "transition",
        to: "review",
        reason: "worker submitted",
      };
    }
    if (decision?.kind === "worker" && decision.submitted === false) {
      return requeueOrFail(attempt, max_attempts, "worker submitted: false");
    }
    // exit 0 with no error marker → submit
    // Note: exit_code null (signal) is not treated as ok — shell maps that to cancelled.
    if (result.exit_code === undefined || result.exit_code === 0) {
      return {
        kind: "transition",
        to: "review",
        reason: "worker ok exit (implicit submit)",
      };
    }
    return requeueOrFail(
      attempt,
      max_attempts,
      `worker non-zero exit ${result.exit_code}`,
    );
  }

  return requeueOrFail(attempt, max_attempts, `worker status ${result.status}`);
}

function requeueOrFail(
  attempt: number,
  max_attempts: number,
  reason: string,
): TaskFsmEffect {
  // attempt is pre-session; after this failure effective attempt becomes attempt+1
  if (attempt + 1 < max_attempts) {
    return {
      kind: "transition",
      to: "ready",
      increment_attempt: true,
      reason,
    };
  }
  return {
    kind: "transition",
    to: "failed",
    increment_attempt: true,
    reason: `${reason} (max_attempts ${max_attempts})`,
  };
}

function mapReviewer(
  result: SessionResult,
  invalid_parse_count: number,
  cancel_reason?: CancelReason,
): TaskFsmEffect {
  if (result.status === "cancelled") {
    // Terminal run/user/budget cancel: leave task cancelled path to scheduler;
    // otherwise stay in review so job can be reassigned.
    if (
      cancel_reason &&
      TERMINAL_CANCEL_REASONS.has(cancel_reason)
    ) {
      return mapCancelEffect(cancel_reason, "reviewer");
    }
    return {
      kind: "stay",
      status_hint: "review",
      reason: `reviewer cancelled; requeue review job`,
    };
  }

  if (
    result.status === "timeout" ||
    result.status === "stall" ||
    result.status === "error"
  ) {
    return {
      kind: "stay",
      status_hint: "review",
      reason: `reviewer ${result.status}; requeue review job`,
    };
  }

  const d = result.decision;
  if (d?.kind === "review") {
    if (d.decision === "approve") {
      return {
        kind: "transition",
        to: "integrating",
        reason: "reviewer approve",
      };
    }
    return {
      kind: "transition",
      to: "ready",
      reason: "reviewer reject",
    };
  }

  // invalid / missing decision
  if (invalid_parse_count >= 1) {
    return {
      kind: "human_intervention",
      reason: "reviewer invalid decision twice",
    };
  }
  return {
    kind: "stay",
    status_hint: "review",
    reason: "reviewer invalid/missing decision; requeue once",
  };
}

function mapQa(
  result: SessionResult,
  invalid_parse_count: number,
  cancel_reason?: CancelReason,
): TaskFsmEffect {
  if (result.status === "cancelled") {
    if (
      cancel_reason &&
      TERMINAL_CANCEL_REASONS.has(cancel_reason)
    ) {
      return mapCancelEffect(cancel_reason, "qa");
    }
    return {
      kind: "stay",
      reason: "qa cancelled; retry job",
    };
  }

  if (
    result.status === "timeout" ||
    result.status === "stall" ||
    result.status === "error"
  ) {
    return {
      kind: "stay",
      reason: `qa ${result.status}; retry job`,
    };
  }

  const d = result.decision;
  if (d?.kind === "qa") {
    if (d.passed) {
      const effect: TaskFsmEffect = {
        kind: "qa_pass",
        reason: "qa passed",
      };
      if (d.summary !== undefined) {
        return { ...effect, summary: d.summary };
      }
      return effect;
    }
    const effect: TaskFsmEffect = {
      kind: "qa_fail",
      reason: "qa failed",
    };
    if (d.summary !== undefined) {
      return { ...effect, summary: d.summary };
    }
    return effect;
  }

  if (invalid_parse_count >= 1) {
    return {
      kind: "human_intervention",
      reason: "qa invalid parse twice",
    };
  }
  return {
    kind: "stay",
    reason: "qa invalid/missing parse; retry once",
  };
}

/** Helper for tests / diagnostics. */
export function decisionSummary(
  decision: StructuredDecision | undefined,
): string {
  if (!decision) return "none";
  if (decision.kind === "worker") {
    return `worker submitted=${decision.submitted}`;
  }
  if (decision.kind === "review") {
    return `review ${decision.decision}`;
  }
  return `qa passed=${decision.passed}`;
}
