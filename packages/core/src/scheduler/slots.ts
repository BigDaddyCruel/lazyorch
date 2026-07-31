/**
 * Concurrent slot accounting (KD-19, KD-26, KD-28).
 *
 * - `slots_used` = count of sessions in starting|running (all roles)
 * - `max_workers` caps worker sessions only
 * - `reserve_slots.lead` holds free capacity for an ephemeral lead when
 *   no lead session is running and the phase needs reservation
 */

import type { AgentRole } from "../types/agent.js";
import type { RunPhase } from "../types/run.js";
import {
  LEAD_RESERVE_PHASES,
  type FreeForWorkersInput,
  type SchedulerSession,
  type SchedulerSessionState,
  type SlotLimits,
  type SlotUsage,
} from "./types.js";

const SLOT_HOLDING: ReadonlySet<SchedulerSessionState> = new Set([
  "starting",
  "running",
]);

/** True when the session currently consumes a concurrent-agent slot. */
export function sessionHoldsSlot(session: SchedulerSession): boolean {
  return SLOT_HOLDING.has(session.state);
}

/** True when phase keeps room for an ephemeral lead (design reservation). */
export function phaseNeedsLeadReservation(phase: RunPhase): boolean {
  return LEAD_RESERVE_PHASES.has(phase);
}

/**
 * Count active sessions by role.
 * Only `starting` and `running` count toward slots / role caps.
 * Idle agent configs hold zero slots (KD-26 / KD-35) but still count in
 * `pool_workers` for elastic desired-vs-active comparison.
 */
export function computeSlotUsage(
  sessions: readonly SchedulerSession[],
): SlotUsage {
  const by_role: Record<AgentRole, number> = {
    lead: 0,
    worker: 0,
    reviewer: 0,
    qa: 0,
    plan_writer: 0,
    plan_reviewer: 0,
  };

  let slots_used = 0;
  let pool_workers = 0;
  for (const s of sessions) {
    if (s.role === "worker" && s.state !== "draining") {
      pool_workers += 1;
    }
    if (!sessionHoldsSlot(s)) continue;
    slots_used += 1;
    by_role[s.role] = (by_role[s.role] ?? 0) + 1;
  }

  return {
    slots_used,
    active_workers: by_role.worker,
    pool_workers,
    active_reviewers: by_role.reviewer,
    active_qa: by_role.qa,
    active_lead: by_role.lead,
    by_role,
  };
}

/**
 * Free slots available for spawning workers, after lead reservation.
 *
 * ```
 * free_for_workers = max_concurrent_agents
 *                  - slots_used
 *                  - (reserve_slots.lead if no lead session running
 *                     and phase needs lead reservation else 0)
 * ```
 */
export function freeForWorkers(input: FreeForWorkersInput): number {
  const reserve =
    !input.lead_session_active && input.lead_reservation_needed
      ? input.reserve_slots_lead
      : 0;
  return Math.max(
    0,
    input.max_concurrent_agents - input.slots_used - reserve,
  );
}

export interface CanStartSessionInput {
  role: AgentRole;
  usage: SlotUsage;
  limits: SlotLimits;
  /** When assigning a worker, also require free_for_workers ≥ 1. */
  free_for_workers?: number;
  /**
   * When true, reusing an idle pool worker — pool size does not grow, so
   * max_workers is not checked against pool_workers (idle already counted).
   */
  reuse_idle?: boolean;
}

/**
 * Whether a worker assignment may proceed (mint or reuse idle).
 * - Always needs a free concurrent slot when the worker will become starting|running
 * - Minting requires `pool_workers < max_workers`
 * - Reusing idle only needs free slots (pool already includes that worker)
 */
export function canStartWorkerAssignment(input: {
  usage: SlotUsage;
  limits: SlotLimits;
  free_for_workers: number;
  reuse_idle: boolean;
}): boolean {
  if (input.usage.slots_used >= input.limits.max_concurrent_agents) {
    return false;
  }
  if (input.free_for_workers < 1) return false;
  if (!input.reuse_idle && input.usage.pool_workers >= input.limits.max_workers) {
    return false;
  }
  return true;
}

/**
 * Whether a new session of `role` may start under hard caps.
 * Lead is capped at 1; workers use max_workers (pool) + free_for_workers;
 * reviewers/qa use their max; all roles share max_concurrent_agents.
 */
export function canStartSession(input: CanStartSessionInput): boolean {
  const { role, usage, limits } = input;

  if (usage.slots_used >= limits.max_concurrent_agents) {
    return false;
  }

  switch (role) {
    case "lead":
      return usage.active_lead < 1;
    case "worker": {
      // max_workers caps the elastic pool (incl. idle), not only slot-holders
      if (input.reuse_idle) {
        // Reuse does not grow the pool
      } else if (usage.pool_workers >= limits.max_workers) {
        return false;
      }
      const free = input.free_for_workers;
      if (free !== undefined && free < 1) return false;
      return true;
    }
    case "reviewer":
      return usage.active_reviewers < limits.max_reviewers;
    case "qa":
      return usage.active_qa < limits.max_qa;
    case "plan_writer":
    case "plan_reviewer":
      // Planning sessions: only hard ceiling (no separate role max in v1)
      return true;
    default:
      return false;
  }
}

/**
 * Convenience: compute free_for_workers from sessions + phase + limits.
 */
export function freeForWorkersFromSessions(
  sessions: readonly SchedulerSession[],
  phase: RunPhase,
  limits: Pick<SlotLimits, "max_concurrent_agents" | "reserve_slots_lead">,
): number {
  const usage = computeSlotUsage(sessions);
  return freeForWorkers({
    max_concurrent_agents: limits.max_concurrent_agents,
    slots_used: usage.slots_used,
    reserve_slots_lead: limits.reserve_slots_lead,
    lead_session_active: usage.active_lead > 0,
    lead_reservation_needed: phaseNeedsLeadReservation(phase),
  });
}

/** Build SlotLimits from scheduler config slices. */
export function slotLimitsFromConfig(cfg: {
  max_concurrent_agents: number;
  max_workers: number;
  max_reviewers: number;
  max_qa: number;
  reserve_slots_lead: number;
}): SlotLimits {
  return {
    max_concurrent_agents: cfg.max_concurrent_agents,
    max_workers: cfg.max_workers,
    max_reviewers: cfg.max_reviewers,
    max_qa: cfg.max_qa,
    reserve_slots_lead: cfg.reserve_slots_lead,
  };
}
