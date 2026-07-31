/**
 * Deterministic elastic worker pool (KD-11, design § Elastic worker pool).
 *
 * Each scheduler tick:
 *   desired = clamp(ceil(ready / scale_up_ready_ratio), min_workers, max_workers)
 *   budget_exhausted → desired = 0
 *   host pressure → no scale-up / pressure scale-down of IDLE only
 *   cooldown + scale_burst gate actual spawn/drain actions
 */

import type { ElasticityConfig } from "@lazyorch/shared";
import type {
  DesiredWorkersInput,
  HostPressure,
  ScaleDecision,
  SchedulerSession,
} from "./types.js";

/** Clamp integer into [lo, hi]. */
export function clampInt(n: number, lo: number, hi: number): number {
  if (hi < lo) return lo;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Core desired-workers formula (no cooldown / spawn side effects).
 *
 * ```
 * desired = clamp(ceil(ready / scale_up_ready_ratio), min_workers, max_workers)
 * if budget_exhausted: desired = 0
 * if host_mem_pct > 90 or host_cpu_pct > 95: desired = min(desired, active_w)
 * if host_mem_pct > 95: desired = max(min_workers, active_w - 1)
 * ```
 */
export function computeDesiredWorkers(input: DesiredWorkersInput): number {
  const {
    ready_count,
    active_workers,
    elasticity,
    budget_exhausted,
    host,
  } = input;

  if (budget_exhausted) {
    return 0;
  }

  const ratio = elasticity.scale_up_ready_ratio;
  const raw =
    ratio > 0 ? Math.ceil(ready_count / ratio) : elasticity.max_workers;

  let desired = clampInt(
    raw,
    elasticity.min_workers,
    elasticity.max_workers,
  );

  if (host) {
    desired = applyHostPressure(
      desired,
      active_workers,
      elasticity.min_workers,
      host,
      elasticity.pressure_scale_down,
    );
  }

  return desired;
}

/**
 * Apply optional host resource pressure (best-effort).
 * - mem > 90 or cpu > 95 → no scale-up (desired ≤ active)
 * - mem > 95 and pressure_scale_down → scale down by 1 (floor min_workers)
 */
export function applyHostPressure(
  desired: number,
  active_workers: number,
  min_workers: number,
  host: HostPressure,
  pressure_scale_down: boolean,
): number {
  const mem = host.mem_pct;
  const cpu = host.cpu_pct;

  let next = desired;

  if (
    (mem !== undefined && mem > 90) ||
    (cpu !== undefined && cpu > 95)
  ) {
    next = Math.min(next, active_workers);
  }

  if (
    pressure_scale_down &&
    mem !== undefined &&
    mem > 95
  ) {
    next = Math.max(min_workers, active_workers - 1);
  }

  return next;
}

export interface ScaleDecisionInput {
  desired: number;
  active_workers: number;
  /** Worker sessions eligible for drain (idle + worktree_clean). */
  idle_drain_candidates: readonly SchedulerSession[];
  elasticity: Pick<
    ElasticityConfig,
    "scale_burst" | "cooldown_seconds" | "min_workers" | "max_workers"
  >;
  /** Free slots after lead reservation (spawn only if ≥ 1). */
  free_for_workers: number;
  now_ms: number;
  last_scale_ms: number;
  /**
   * When true, elasticity is paused (e.g. integrate conflict storm).
   * No spawn; drain still allowed only if desired < active.
   */
  pause_elasticity?: boolean;
}

/**
 * Decide spawn/drain for this tick given desired vs active and cooldown.
 * Never drains assignees of in_progress/review tasks — only idle+clean.
 */
export function decideScale(input: ScaleDecisionInput): ScaleDecision {
  const {
    desired,
    active_workers,
    idle_drain_candidates,
    elasticity,
    free_for_workers,
    now_ms,
    last_scale_ms,
    pause_elasticity,
  } = input;

  const cooldownMs = elasticity.cooldown_seconds * 1000;
  const cooldownElapsed =
    last_scale_ms === 0 || now_ms - last_scale_ms >= cooldownMs;

  if (desired > active_workers) {
    if (pause_elasticity) {
      return {
        desired,
        active_workers,
        action: "none",
        spawn_count: 0,
        drain_handles: [],
        reason: "elasticity_paused",
      };
    }
    if (!cooldownElapsed) {
      return {
        desired,
        active_workers,
        action: "none",
        spawn_count: 0,
        drain_handles: [],
        reason: "cooldown",
      };
    }
    if (free_for_workers < 1) {
      return {
        desired,
        active_workers,
        action: "none",
        spawn_count: 0,
        drain_handles: [],
        reason: "no_free_slots",
      };
    }
    if (active_workers >= elasticity.max_workers) {
      return {
        desired,
        active_workers,
        action: "none",
        spawn_count: 0,
        drain_handles: [],
        reason: "max_workers",
      };
    }

    const gap = desired - active_workers;
    const room = elasticity.max_workers - active_workers;
    const spawn_count = Math.min(
      gap,
      elasticity.scale_burst,
      room,
      free_for_workers,
    );

    if (spawn_count <= 0) {
      return {
        desired,
        active_workers,
        action: "none",
        spawn_count: 0,
        drain_handles: [],
        reason: "no_spawn_capacity",
      };
    }

    return {
      desired,
      active_workers,
      action: "spawn",
      spawn_count,
      drain_handles: [],
      reason: "scale_up",
    };
  }

  if (desired < active_workers) {
    if (!cooldownElapsed) {
      return {
        desired,
        active_workers,
        action: "none",
        spawn_count: 0,
        drain_handles: [],
        reason: "cooldown",
      };
    }

    const needDrain = active_workers - desired;
    const drain_handles = idle_drain_candidates
      .filter(
        (s) =>
          s.role === "worker" &&
          s.state === "idle" &&
          s.worktree_clean === true &&
          s.task_id === undefined,
      )
      .slice(0, needDrain)
      .map((s) => s.run_handle);

    if (drain_handles.length === 0) {
      return {
        desired,
        active_workers,
        action: "none",
        spawn_count: 0,
        drain_handles: [],
        reason: "no_idle_clean_workers",
      };
    }

    return {
      desired,
      active_workers,
      action: "drain",
      spawn_count: 0,
      drain_handles,
      reason: "scale_down",
    };
  }

  return {
    desired,
    active_workers,
    action: "none",
    spawn_count: 0,
    drain_handles: [],
    reason: "at_desired",
  };
}

/**
 * Workers that may be scaled down: state idle, no task, worktree clean.
 * Dirty idle workers are never auto-drained (needs_reap_review path).
 */
export function idleDrainCandidates(
  sessions: readonly SchedulerSession[],
  scale_down_idle_minutes: number,
  now_ms: number,
): SchedulerSession[] {
  const idleMs = scale_down_idle_minutes * 60_000;
  return sessions.filter((s) => {
    if (s.role !== "worker") return false;
    if (s.state !== "idle") return false;
    if (s.task_id !== undefined) return false;
    if (s.worktree_clean !== true) return false;
    if (now_ms - s.last_activity_ms < idleMs) return false;
    return true;
  });
}
