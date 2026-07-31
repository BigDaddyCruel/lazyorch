/**
 * Team mode resolution — full | solo (KD-25).
 *
 * Solo forces:
 * - max/min workers = 0
 * - min/max reviewers = 0, min/max qa = 0
 * - gates.task_approve + plan_approve + merge = true
 * - plan writer may equal plan reviewer
 */

import type { TeamMode } from "../types/team.js";
import type { EffectiveTeamLimits } from "./types.js";

export interface ResolveTeamModeInput {
  mode: TeamMode;
  min_workers?: number;
  max_workers?: number;
  min_reviewers?: number;
  max_reviewers?: number;
  min_qa?: number;
  max_qa?: number;
  /** Existing gate flags (solo forces true; full preserves). */
  gates?: {
    task_approve?: boolean;
    plan_approve?: boolean;
    merge?: boolean;
  };
}

/**
 * Apply team.mode compensating limits and gates.
 * Pure; does not mutate config objects.
 */
export function resolveTeamMode(input: ResolveTeamModeInput): EffectiveTeamLimits {
  if (input.mode === "solo") {
    return {
      mode: "solo",
      min_workers: 0,
      max_workers: 0,
      min_reviewers: 0,
      max_reviewers: 0,
      min_qa: 0,
      max_qa: 0,
      gates: {
        task_approve: true,
        plan_approve: true,
        merge: true,
      },
      allow_plan_writer_eq_reviewer: true,
    };
  }

  const minWorkers = input.min_workers ?? 0;
  const maxWorkers = input.max_workers ?? 4;
  const minReviewers = input.min_reviewers ?? 1;
  const maxReviewers = input.max_reviewers ?? 2;
  const minQa = input.min_qa ?? 1;
  const maxQa = input.max_qa ?? 2;

  return {
    mode: "full",
    min_workers: minWorkers,
    max_workers: Math.max(minWorkers, maxWorkers),
    min_reviewers: minReviewers,
    max_reviewers: Math.max(minReviewers, maxReviewers),
    min_qa: minQa,
    max_qa: Math.max(minQa, maxQa),
    gates: {
      task_approve: input.gates?.task_approve ?? false,
      plan_approve: input.gates?.plan_approve ?? true,
      merge: input.gates?.merge ?? true,
    },
    allow_plan_writer_eq_reviewer: false,
  };
}

/** True when solo mode forces human task approval on every task. */
export function soloForcesTaskApprove(mode: TeamMode): boolean {
  return mode === "solo";
}

/**
 * Whether plan_writer and plan_reviewer may collapse to the same agent.
 * Only allowed in solo (design KD-25 / planning segregation).
 */
export function mayCollapsePlanWriterAndReviewer(mode: TeamMode): boolean {
  return mode === "solo";
}
