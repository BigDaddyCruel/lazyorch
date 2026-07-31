/**
 * Concurrent slot packing validation (KD-19, KD-28).
 *
 * Hard error when min team cannot pack under the ceiling:
 *   reserve_slots.lead + max_workers + min_reviewers + min_qa
 *     ≤ max_concurrent_agents
 *
 * Soft warn when peak all-roles concurrent is impossible:
 *   reserve_slots.lead + max_workers + max_reviewers + max_qa
 *     ≤ max_concurrent_agents
 */

export interface SlotPackingInput {
  max_concurrent_agents: number;
  max_workers: number;
  /** `reserve_slots.lead` (default 1). */
  reserve_slots_lead: number;
  min_reviewers: number;
  min_qa: number;
  max_reviewers?: number;
  max_qa?: number;
}

export interface SlotPackingResult {
  ok: boolean;
  /** lead + max_workers + min_reviewers + min_qa */
  minRequired: number;
  /** lead + max_workers + max_reviewers + max_qa (falls back to mins if max omitted) */
  peakRequired: number;
  maxConcurrentAgents: number;
  errors: string[];
  warnings: string[];
}

/** Compute min-team slot demand for packing. */
export function minSlotDemand(input: SlotPackingInput): number {
  return (
    input.reserve_slots_lead +
    input.max_workers +
    input.min_reviewers +
    input.min_qa
  );
}

/** Compute peak all-roles slot demand for packing warn. */
export function peakSlotDemand(input: SlotPackingInput): number {
  const maxReviewers = input.max_reviewers ?? input.min_reviewers;
  const maxQa = input.max_qa ?? input.min_qa;
  return (
    input.reserve_slots_lead + input.max_workers + maxReviewers + maxQa
  );
}

/**
 * Validate slot packing invariants.
 * `ok` is false only when the hard min-team packing invariant fails.
 */
export function validateSlotPacking(input: SlotPackingInput): SlotPackingResult {
  const minRequired = minSlotDemand(input);
  const peakRequired = peakSlotDemand(input);
  const errors: string[] = [];
  const warnings: string[] = [];

  if (minRequired > input.max_concurrent_agents) {
    errors.push(
      `slot packing: reserve_slots.lead (${input.reserve_slots_lead}) + max_workers (${input.max_workers}) + min_reviewers (${input.min_reviewers}) + min_qa (${input.min_qa}) = ${minRequired} > max_concurrent_agents (${input.max_concurrent_agents})`,
    );
  }

  if (peakRequired > input.max_concurrent_agents) {
    const maxReviewers = input.max_reviewers ?? input.min_reviewers;
    const maxQa = input.max_qa ?? input.min_qa;
    warnings.push(
      `slot packing peak: reserve_slots.lead (${input.reserve_slots_lead}) + max_workers (${input.max_workers}) + max_reviewers (${maxReviewers}) + max_qa (${maxQa}) = ${peakRequired} > max_concurrent_agents (${input.max_concurrent_agents}); scheduler may starve lower-priority roles`,
    );
  }

  return {
    ok: errors.length === 0,
    minRequired,
    peakRequired,
    maxConcurrentAgents: input.max_concurrent_agents,
    errors,
    warnings,
  };
}
