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
   * Cancel reason when status is cancelled.
   * "replan_supersede" keeps task in_progress semantics for replan.
   */
  cancel_reason?: string;
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
    session_kind,
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

  // Deterministic / shell: ok iff exit 0; no LLM decision required unless present
  if (session_kind === "deterministic" && role === "worker") {
    return mapWorker(result, attempt, max_attempts);
  }

  if (role === "worker") {
    return mapWorker(result, attempt, max_attempts);
  }

  if (role === "reviewer") {
    return mapReviewer(result, invalid_parse_count);
  }

  if (role === "qa") {
    return mapQa(result, invalid_parse_count);
  }

  // timeout / stall on any role
  if (result.status === "timeout" || result.status === "stall") {
    return {
      kind: "transition",
      to: "ready",
      increment_attempt: true,
      reason: `session ${result.status}`,
    };
  }

  if (result.status === "cancelled") {
    if (cancel_reason === "replan_supersede") {
      return {
        kind: "stay",
        status_hint: "in_progress",
        reason: "cancelled for replan supersede",
      };
    }
    return {
      kind: "transition",
      to: "ready",
      increment_attempt: true,
      reason: "session cancelled",
    };
  }

  return { kind: "none", reason: `no mapping for role ${role}` };
}

function mapWorker(
  result: SessionResult,
  attempt: number,
  max_attempts: number,
): TaskFsmEffect {
  if (result.status === "cancelled") {
    return {
      kind: "transition",
      to: "ready",
      increment_attempt: true,
      reason: "worker cancelled",
    };
  }

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
): TaskFsmEffect {
  if (
    result.status === "timeout" ||
    result.status === "stall" ||
    result.status === "error" ||
    result.status === "cancelled"
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
): TaskFsmEffect {
  if (
    result.status === "timeout" ||
    result.status === "stall" ||
    result.status === "error" ||
    result.status === "cancelled"
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
