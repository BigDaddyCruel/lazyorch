/**
 * Scheduler tick: elasticity + assign ready tasks (+ router at assign).
 *
 * Caller contract (normative):
 * 1. Apply `assign.assigned` session plans first (mint or idle-reuse).
 * 2. `scale.spawn_count` is **only** additional idle pre-warm to reach
 *    `desired` after assign (e.g. min_workers floor with no ready work).
 *    It is recomputed post-assign so free slots / pool are not double-claimed.
 * 3. Apply `scale.drain_handles` to mark idle workers draining.
 *
 * Assign respects `desired` and `budget_exhausted` via max_assign.
 * Role-template matching (PR-13): `team.worker_templates` → matchWorkerTemplate
 * at assign; stamps `session_plan.worker_template_id` and session labels.
 * Idle reuse prefers workers whose labels intersect the matched template.
 */

import type { ElasticityConfig, SchedulingConfig } from "@lazyorch/shared";
import { getRoleTemplate } from "../team/role-templates.js";
import type { RunPhase } from "../types/run.js";
import type { Task } from "../types/task.js";
import {
  assignReadyTasks,
  assignReadyTasksAsync,
  maxAssignTowardDesired,
  type AssignReadyOptions,
  type AssignRoutingOptions,
} from "./assign.js";
import {
  computeDesiredWorkers,
  decideScale,
  idleDrainCandidates,
} from "./elasticity.js";
import { SchedulerMetrics } from "./metrics.js";
import {
  computeSlotUsage,
  freeForWorkers,
  phaseNeedsLeadReservation,
  slotLimitsFromConfig,
} from "./slots.js";
import type {
  AssignBatchResult,
  HostPressure,
  ScaleDecision,
  SchedulerConfig,
  SchedulerRuntimeState,
  SchedulerSession,
  ScopeLockPort,
  SlotLimits,
  WorktreePort,
} from "./types.js";

export interface SchedulerTickInput {
  tasks: readonly Task[];
  phase: RunPhase;
  runtime: SchedulerRuntimeState;
  config: SchedulerConfig;
  locks: ScopeLockPort;
  worktrees?: WorktreePort;
  routing?: AssignRoutingOptions;
  metrics?: SchedulerMetrics;
  now_ms?: number;
  host?: HostPressure;
  budget_exhausted?: boolean;
  /** Freeze pool size both up and down (conflict storm). */
  pause_elasticity?: boolean;
  skip_scope_lock_task_ids?: ReadonlySet<string>;
  /** Override max assignments this tick (bypasses desired cap). */
  max_assign?: number;
}

export interface SchedulerTickResult {
  desired_workers: number;
  scale: ScaleDecision;
  assign: AssignBatchResult;
  /** Updated runtime (sessions may mark draining; waits updated). */
  runtime: SchedulerRuntimeState;
  usage: ReturnType<typeof computeSlotUsage>;
  free_for_workers: number;
}

function limitsFrom(config: SchedulerConfig): SlotLimits {
  return slotLimitsFromConfig({
    max_concurrent_agents: config.scheduling.max_concurrent_agents,
    max_workers: config.elasticity.max_workers,
    max_reviewers: config.team.max_reviewers,
    max_qa: config.team.max_qa,
    reserve_slots_lead: config.reserve_slots.lead,
  });
}

function countReady(tasks: readonly Task[]): number {
  return tasks.filter((t) => t.status === "ready").length;
}

/**
 * Compute desired workers + scale decision without assigning tasks.
 */
export function planElasticity(input: {
  tasks: readonly Task[];
  sessions: readonly SchedulerSession[];
  elasticity: ElasticityConfig;
  scheduling: Pick<SchedulingConfig, "max_concurrent_agents">;
  reserve_slots_lead: number;
  phase: RunPhase;
  now_ms: number;
  last_scale_ms: number;
  host?: HostPressure;
  budget_exhausted?: boolean;
  pause_elasticity?: boolean;
}): { desired: number; scale: ScaleDecision; free_for_workers: number } {
  const usage = computeSlotUsage(input.sessions);
  const free = freeForWorkers({
    max_concurrent_agents: input.scheduling.max_concurrent_agents,
    slots_used: usage.slots_used,
    reserve_slots_lead: input.reserve_slots_lead,
    lead_session_active: usage.active_lead > 0,
    lead_reservation_needed: phaseNeedsLeadReservation(input.phase),
  });

  const desiredInput: Parameters<typeof computeDesiredWorkers>[0] = {
    ready_count: countReady(input.tasks),
    active_workers: usage.pool_workers,
    elasticity: input.elasticity,
  };
  if (input.budget_exhausted !== undefined) {
    desiredInput.budget_exhausted = input.budget_exhausted;
  }
  if (input.host !== undefined) {
    desiredInput.host = input.host;
  }
  const desired = computeDesiredWorkers(desiredInput);

  const idle = idleDrainCandidates(
    input.sessions,
    input.elasticity.scale_down_idle_minutes,
    input.now_ms,
  );

  const scaleInput: Parameters<typeof decideScale>[0] = {
    desired,
    active_workers: usage.pool_workers,
    idle_drain_candidates: idle,
    elasticity: input.elasticity,
    free_for_workers: free,
    now_ms: input.now_ms,
    last_scale_ms: input.last_scale_ms,
  };
  if (input.pause_elasticity !== undefined) {
    scaleInput.pause_elasticity = input.pause_elasticity;
  }
  const scale = decideScale(scaleInput);

  return { desired, scale, free_for_workers: free };
}

/**
 * True if a session is still a valid scale-down target after assign.
 * Matches `idleDrainCandidates` / design: idle, no task, worktree clean.
 * Dirty idle workers are never auto-drained (needs_reap_review path).
 */
export function isStillDrainable(
  session: SchedulerSession | undefined,
): boolean {
  if (!session) return false;
  return (
    session.role === "worker" &&
    session.state === "idle" &&
    session.task_id === undefined &&
    session.worktree_clean === true
  );
}

/**
 * Filter pre-assign drain handles after idle reuse (Issue 11).
 * Only keep handles that are still idle + clean + no task; never drain a
 * run_handle that assign just claimed. If some pre-selected handles were
 * reused, backfill from remaining clean idle sessions up to needDrain
 * (Issue 12: never backfill dirty idle).
 */
export function filterDrainHandlesAfterAssign(input: {
  pre_drain_handles: readonly string[];
  sessions_after_assign: readonly SchedulerSession[];
  /** How many workers to remove: max(0, pool - desired). */
  need_drain: number;
  /** run_handles claimed by assign this tick (must never drain). */
  assigned_handles?: ReadonlySet<string>;
}): string[] {
  const byHandle = new Map(
    input.sessions_after_assign.map((s) => [s.run_handle, s]),
  );
  const assigned = input.assigned_handles ?? new Set<string>();
  const need = Math.max(0, input.need_drain);
  if (need === 0) return [];

  const stillOk = (h: string): boolean => {
    if (assigned.has(h)) return false;
    return isStillDrainable(byHandle.get(h));
  };

  const out: string[] = [];
  for (const h of input.pre_drain_handles) {
    if (out.length >= need) break;
    if (stillOk(h) && !out.includes(h)) out.push(h);
  }

  if (out.length < need) {
    // Backfill remaining idle workers (stable by last_activity then handle)
    const candidates = input.sessions_after_assign
      .filter(
        (s) =>
          isStillDrainable(s) &&
          !assigned.has(s.run_handle) &&
          !out.includes(s.run_handle),
      )
      .sort((a, b) => {
        if (a.last_activity_ms !== b.last_activity_ms) {
          return a.last_activity_ms - b.last_activity_ms;
        }
        return a.run_handle < b.run_handle
          ? -1
          : a.run_handle > b.run_handle
            ? 1
            : 0;
      });
    for (const s of candidates) {
      if (out.length >= need) break;
      out.push(s.run_handle);
    }
  }

  return out;
}

/**
 * After assign, recompute idle pre-warm spawn so it does not double-claim
 * free slots already consumed by assignment (Issue 4).
 * Drain handles are filtered so idle-reuse assign never collides (Issue 11).
 *
 * Assign is the primary path for workers with tasks. `spawn_count` only
 * fills remaining desired gap (e.g. min_workers) with task-less idle workers.
 */
export function clampSpawnAfterAssign(input: {
  desired: number;
  /** Sessions after assign + before optional pre-warm spawn. */
  sessions_after_assign: readonly SchedulerSession[];
  elasticity: Pick<
    ElasticityConfig,
    "scale_burst" | "max_workers" | "cooldown_seconds"
  >;
  free_for_workers_after: number;
  now_ms: number;
  last_scale_ms: number;
  pause_elasticity?: boolean;
  /** Pre-assign scale decision (for drain handles / cooldown reason). */
  pre_scale: ScaleDecision;
  /** run_handles claimed by assign this tick (idle reuse or mint). */
  assigned_handles?: ReadonlySet<string>;
}): ScaleDecision {
  const usage = computeSlotUsage(input.sessions_after_assign);
  const pool = usage.pool_workers;

  // Scale-down: re-filter drain targets after assign (Issue 11).
  if (input.pre_scale.action === "drain") {
    if (input.pause_elasticity) {
      return {
        desired: input.desired,
        active_workers: pool,
        action: "none",
        spawn_count: 0,
        drain_handles: [],
        reason: "elasticity_paused",
      };
    }
    const needDrain = Math.max(0, pool - input.desired);
    const filterInput: Parameters<typeof filterDrainHandlesAfterAssign>[0] = {
      pre_drain_handles: input.pre_scale.drain_handles,
      sessions_after_assign: input.sessions_after_assign,
      need_drain: needDrain,
    };
    if (input.assigned_handles) {
      filterInput.assigned_handles = input.assigned_handles;
    }
    const drain_handles = filterDrainHandlesAfterAssign(filterInput);
    if (drain_handles.length === 0) {
      return {
        desired: input.desired,
        active_workers: pool,
        action: "none",
        spawn_count: 0,
        drain_handles: [],
        reason: needDrain === 0 ? "at_desired" : "no_idle_clean_workers",
      };
    }
    return {
      desired: input.desired,
      active_workers: pool,
      action: "drain",
      spawn_count: 0,
      drain_handles,
      reason: "scale_down",
    };
  }

  if (input.pause_elasticity) {
    return {
      desired: input.desired,
      active_workers: pool,
      action: "none",
      spawn_count: 0,
      drain_handles: [],
      reason: "elasticity_paused",
    };
  }

  if (input.desired <= pool) {
    return {
      desired: input.desired,
      active_workers: pool,
      action: "none",
      spawn_count: 0,
      drain_handles: [],
      reason: input.desired === pool ? "at_desired" : "assign_filled_desired",
    };
  }

  const cooldownMs = input.elasticity.cooldown_seconds * 1000;
  const cooldownElapsed =
    input.last_scale_ms === 0 ||
    input.now_ms - input.last_scale_ms >= cooldownMs;
  if (!cooldownElapsed) {
    return {
      desired: input.desired,
      active_workers: pool,
      action: "none",
      spawn_count: 0,
      drain_handles: [],
      reason: "cooldown",
    };
  }

  if (input.free_for_workers_after < 1) {
    return {
      desired: input.desired,
      active_workers: pool,
      action: "none",
      spawn_count: 0,
      drain_handles: [],
      reason: "no_free_slots",
    };
  }

  if (pool >= input.elasticity.max_workers) {
    return {
      desired: input.desired,
      active_workers: pool,
      action: "none",
      spawn_count: 0,
      drain_handles: [],
      reason: "max_workers",
    };
  }

  const gap = input.desired - pool;
  const room = input.elasticity.max_workers - pool;
  const spawn_count = Math.min(
    gap,
    input.elasticity.scale_burst,
    room,
    input.free_for_workers_after,
  );

  if (spawn_count <= 0) {
    return {
      desired: input.desired,
      active_workers: pool,
      action: "none",
      spawn_count: 0,
      drain_handles: [],
      reason: "no_spawn_capacity",
    };
  }

  return {
    desired: input.desired,
    active_workers: pool,
    action: "spawn",
    spawn_count,
    drain_handles: [],
    reason: "scale_up",
  };
}

function applyDrain(
  sessions: SchedulerSession[],
  drain_handles: readonly string[],
  now_ms: number,
): SchedulerSession[] {
  if (drain_handles.length === 0) return sessions;
  const set = new Set(drain_handles);
  return sessions.map((s) => {
    if (!set.has(s.run_handle)) return s;
    // Defensive: never drain a session that is no longer idle/unassigned
    // (e.g. same-tick idle reuse that slipped past filter).
    if (!isStillDrainable(s)) return s;
    return { ...s, state: "draining" as const, last_activity_ms: now_ms };
  });
}

function buildAssignOptions(
  input: SchedulerTickInput,
  limits: SlotLimits,
  now: number,
  agentSeq: { value: number },
): AssignReadyOptions {
  const opts: AssignReadyOptions = {
    tasks: input.tasks,
    sessions: input.runtime.sessions,
    phase: input.phase,
    limits,
    locks: input.locks,
    scope_lock_waits: input.runtime.scope_lock_waits,
    scope_lock_wait_ms: input.config.scheduling.scope_lock_wait_ms,
    now_ms: now,
  };
  if (input.worktrees) opts.worktrees = input.worktrees;
  if (input.routing) opts.routing = input.routing;
  if (input.metrics) opts.metrics = input.metrics;
  if (input.skip_scope_lock_task_ids) {
    opts.skip_scope_lock_task_ids = input.skip_scope_lock_task_ids;
  }
  if (input.max_assign !== undefined) opts.max_assign = input.max_assign;
  // PR-13: role-template matching uses team.worker_templates
  if (input.config.team.worker_templates?.length) {
    opts.worker_templates = input.config.team.worker_templates;
  }

  opts.nextAgentId = () => {
    agentSeq.value += 1;
    return `agt_sched_${agentSeq.value.toString(16).padStart(8, "0")}`;
  };
  return opts;
}

/**
 * Merge assign results into session list: reuse updates idle → starting;
 * mint appends pending_* workers.
 */
export function applyAssignToSessions(
  sessions: readonly SchedulerSession[],
  assign: AssignBatchResult,
  now: number,
): SchedulerSession[] {
  let next = sessions.map((s) => ({ ...s }));
  for (const a of assign.assigned) {
    const plan = a.session_plan;
    const tplLabels =
      plan.worker_template_id !== undefined
        ? getRoleTemplate(plan.worker_template_id)?.labels
        : undefined;

    if (plan.reused_idle) {
      const idx = next.findIndex((s) => s.run_handle === plan.run_handle);
      if (idx >= 0) {
        const prev = next[idx]!;
        const updated: SchedulerSession = {
          ...prev,
          state: "starting",
          task_id: a.task.id,
          adapter_id: plan.adapter_id,
          model: plan.model,
          model_tier: plan.model_tier,
          last_activity_ms: now,
        };
        if (tplLabels) updated.labels = [...tplLabels];
        else if (prev.labels) updated.labels = [...prev.labels];
        next[idx] = updated;
      }
    } else {
      const minted: SchedulerSession = {
        run_handle: plan.run_handle,
        agent_id: plan.agent_id,
        role: "worker",
        task_id: a.task.id,
        state: "starting",
        adapter_id: plan.adapter_id,
        model: plan.model,
        model_tier: plan.model_tier,
        last_activity_ms: now,
      };
      if (tplLabels) minted.labels = [...tplLabels];
      next = [...next, minted];
    }
  }
  return next;
}

function finalizeRuntime(
  input: SchedulerTickInput,
  assign: AssignBatchResult,
  scale: ScaleDecision,
  now: number,
  agentSeq: number,
  sessionsAfterAssign: SchedulerSession[],
): SchedulerRuntimeState {
  // Drain after assign (never drain workers just assigned)
  const sessions = applyDrain(sessionsAfterAssign, scale.drain_handles, now);

  const scaled = scale.action === "spawn" || scale.action === "drain";

  return {
    sessions,
    scope_lock_waits: assign.scope_lock_waits,
    last_scale_ms: scaled ? now : input.runtime.last_scale_ms,
    scale_events: input.runtime.scale_events + (scaled ? 1 : 0),
    agent_seq: agentSeq,
  };
}

function updateMetrics(
  metrics: SchedulerMetrics | undefined,
  desired: number,
  usage: ReturnType<typeof computeSlotUsage>,
  scale: ScaleDecision,
): void {
  if (!metrics) return;
  metrics.setGauges({
    "scheduler.desired_workers": desired,
    "scheduler.active_workers": usage.pool_workers,
    "scheduler.slots_used": usage.slots_used,
  });
  metrics.recordScaleEvent(scale.action);
}

function runTickCore(
  input: SchedulerTickInput,
  assign: AssignBatchResult,
  now: number,
  agentSeq: number,
  desired: number,
  preScale: ScaleDecision,
  freeBefore: number,
): SchedulerTickResult {
  const sessionsAfterAssign = applyAssignToSessions(
    input.runtime.sessions,
    assign,
    now,
  );

  const usageAfter = computeSlotUsage(sessionsAfterAssign);
  const freeAfter = freeForWorkers({
    max_concurrent_agents: input.config.scheduling.max_concurrent_agents,
    slots_used: usageAfter.slots_used,
    reserve_slots_lead: input.config.reserve_slots.lead,
    lead_session_active: usageAfter.active_lead > 0,
    lead_reservation_needed: phaseNeedsLeadReservation(input.phase),
  });

  const assignedHandles = new Set(
    assign.assigned.map((a) => a.session_plan.run_handle),
  );
  const clampInput: Parameters<typeof clampSpawnAfterAssign>[0] = {
    desired,
    sessions_after_assign: sessionsAfterAssign,
    elasticity: input.config.elasticity,
    free_for_workers_after: freeAfter,
    now_ms: now,
    last_scale_ms: input.runtime.last_scale_ms,
    pre_scale: preScale,
    assigned_handles: assignedHandles,
  };
  if (input.pause_elasticity !== undefined) {
    clampInput.pause_elasticity = input.pause_elasticity;
  }
  const scale = clampSpawnAfterAssign(clampInput);

  const runtime = finalizeRuntime(
    input,
    assign,
    scale,
    now,
    agentSeq,
    sessionsAfterAssign,
  );
  const usage = computeSlotUsage(runtime.sessions);
  updateMetrics(input.metrics, desired, usage, scale);

  return {
    desired_workers: desired,
    scale,
    assign,
    runtime,
    usage,
    free_for_workers: freeBefore,
  };
}

/**
 * One scheduler tick (sync worktrees / fakes).
 * Does not spawn OS processes — returns assign plans + scale decision.
 */
export function schedulerTick(input: SchedulerTickInput): SchedulerTickResult {
  const now = input.now_ms ?? Date.now();
  const limits = limitsFrom(input.config);

  const planInput: Parameters<typeof planElasticity>[0] = {
    tasks: input.tasks,
    sessions: input.runtime.sessions,
    elasticity: input.config.elasticity,
    scheduling: input.config.scheduling,
    reserve_slots_lead: input.config.reserve_slots.lead,
    phase: input.phase,
    now_ms: now,
    last_scale_ms: input.runtime.last_scale_ms,
  };
  if (input.host !== undefined) planInput.host = input.host;
  if (input.budget_exhausted !== undefined) {
    planInput.budget_exhausted = input.budget_exhausted;
  }
  if (input.pause_elasticity !== undefined) {
    planInput.pause_elasticity = input.pause_elasticity;
  }
  const { desired, scale: preScale, free_for_workers } =
    planElasticity(planInput);

  const preUsage = computeSlotUsage(input.runtime.sessions);
  const agentSeq = { value: input.runtime.agent_seq };
  const assignOpts = buildAssignOptions(input, limits, now, agentSeq);

  // Issue 1: cap assign by desired / budget (not free slots alone)
  if (input.max_assign === undefined) {
    const capInput: Parameters<typeof maxAssignTowardDesired>[0] = {
      free_for_workers,
      desired,
      active_workers: preUsage.active_workers,
    };
    if (input.budget_exhausted !== undefined) {
      capInput.budget_exhausted = input.budget_exhausted;
    }
    assignOpts.max_assign = maxAssignTowardDesired(capInput);
  }

  const assign = assignReadyTasks(assignOpts);
  return runTickCore(
    input,
    assign,
    now,
    agentSeq.value,
    desired,
    preScale,
    free_for_workers,
  );
}

/**
 * Async tick (worktree port may return Promises).
 */
export async function schedulerTickAsync(
  input: SchedulerTickInput,
): Promise<SchedulerTickResult> {
  const now = input.now_ms ?? Date.now();
  const limits = limitsFrom(input.config);

  const planInput: Parameters<typeof planElasticity>[0] = {
    tasks: input.tasks,
    sessions: input.runtime.sessions,
    elasticity: input.config.elasticity,
    scheduling: input.config.scheduling,
    reserve_slots_lead: input.config.reserve_slots.lead,
    phase: input.phase,
    now_ms: now,
    last_scale_ms: input.runtime.last_scale_ms,
  };
  if (input.host !== undefined) planInput.host = input.host;
  if (input.budget_exhausted !== undefined) {
    planInput.budget_exhausted = input.budget_exhausted;
  }
  if (input.pause_elasticity !== undefined) {
    planInput.pause_elasticity = input.pause_elasticity;
  }
  const { desired, scale: preScale, free_for_workers } =
    planElasticity(planInput);

  const preUsage = computeSlotUsage(input.runtime.sessions);
  const agentSeq = { value: input.runtime.agent_seq };
  const assignOpts = buildAssignOptions(input, limits, now, agentSeq);

  if (input.max_assign === undefined) {
    const capInput: Parameters<typeof maxAssignTowardDesired>[0] = {
      free_for_workers,
      desired,
      active_workers: preUsage.active_workers,
    };
    if (input.budget_exhausted !== undefined) {
      capInput.budget_exhausted = input.budget_exhausted;
    }
    assignOpts.max_assign = maxAssignTowardDesired(capInput);
  }

  const assign = await assignReadyTasksAsync(assignOpts);
  return runTickCore(
    input,
    assign,
    now,
    agentSeq.value,
    desired,
    preScale,
    free_for_workers,
  );
}

/** Default scheduler config slices matching design defaults. */
export function defaultSchedulerConfig(): SchedulerConfig {
  return {
    elasticity: {
      min_workers: 0,
      max_workers: 4,
      scale_up_ready_ratio: 2,
      scale_down_idle_minutes: 10,
      cooldown_seconds: 60,
      scale_burst: 1,
      pressure_scale_down: true,
    },
    scheduling: {
      max_concurrent_agents: 8,
      tick_interval_ms: 5000,
      stall_timeout_ms: 600_000,
      retry_base_delay_ms: 10_000,
      retry_max_delay_ms: 300_000,
      task_max_attempts: 3,
      on_task_terminal_failed: "gate",
      failed_escalation_ms: 0,
      scope_lock_wait_ms: 60_000,
      cancel_grace_ms: 30_000,
    },
    reserve_slots: { lead: 1 },
    team: {
      mode: "full",
      max_reviewers: 2,
      max_qa: 2,
      min_reviewers: 1,
      min_qa: 1,
      worker_templates: ["fullstack-dev", "backend-dev", "frontend-dev"],
    },
  };
}
