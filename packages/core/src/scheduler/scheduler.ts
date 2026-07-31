/**
 * Scheduler tick: elasticity + assign ready tasks (+ router at assign).
 *
 * Orchestrates pure helpers; I/O stays behind ports (locks, worktrees).
 * Session process start is the caller's job (adapters session runner).
 */

import type { ElasticityConfig, SchedulingConfig } from "@lazyorch/shared";
import type { RunPhase } from "../types/run.js";
import type { Task } from "../types/task.js";
import {
  assignReadyTasks,
  assignReadyTasksAsync,
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
  pause_elasticity?: boolean;
  skip_scope_lock_task_ids?: ReadonlySet<string>;
  /** Override max assignments this tick. */
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

  // Elasticity compares desired against pool size (includes idle workers).
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

function applyDrain(
  sessions: SchedulerSession[],
  drain_handles: readonly string[],
  now_ms: number,
): SchedulerSession[] {
  if (drain_handles.length === 0) return sessions;
  const set = new Set(drain_handles);
  return sessions.map((s) => {
    if (!set.has(s.run_handle)) return s;
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

  opts.nextAgentId = () => {
    agentSeq.value += 1;
    return `agt_sched_${agentSeq.value.toString(16).padStart(8, "0")}`;
  };
  return opts;
}

function finalizeRuntime(
  input: SchedulerTickInput,
  assign: AssignBatchResult,
  scale: ScaleDecision,
  now: number,
  agentSeq: number,
): SchedulerRuntimeState {
  let sessions = applyDrain(
    input.runtime.sessions,
    scale.drain_handles,
    now,
  );

  // Reflect assigned sessions as starting workers (caller starts real processes)
  for (const a of assign.assigned) {
    sessions = [
      ...sessions,
      {
        run_handle: `pending_${a.task.id}`,
        agent_id: a.session_plan.agent_id,
        role: "worker",
        task_id: a.task.id,
        state: "starting",
        adapter_id: a.session_plan.adapter_id,
        model: a.session_plan.model,
        model_tier: a.session_plan.model_tier,
        last_activity_ms: now,
      },
    ];
  }

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
    // Expose pool size (incl. idle) as active_workers gauge per design metric name
    "scheduler.active_workers": usage.pool_workers,
    "scheduler.slots_used": usage.slots_used,
  });
  metrics.recordScaleEvent(scale.action);
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
  const { desired, scale, free_for_workers } = planElasticity(planInput);

  const agentSeq = { value: input.runtime.agent_seq };
  const assignOpts = buildAssignOptions(input, limits, now, agentSeq);
  // Cap assigns by free slots (elasticity spawn_count is advisory pool sizing;
  // assignment claims ready work immediately when slots are free).
  if (input.max_assign === undefined) {
    assignOpts.max_assign = free_for_workers;
  }

  const assign = assignReadyTasks(assignOpts);
  const runtime = finalizeRuntime(
    input,
    assign,
    scale,
    now,
    agentSeq.value,
  );
  const usage = computeSlotUsage(runtime.sessions);
  updateMetrics(input.metrics, desired, usage, scale);

  return {
    desired_workers: desired,
    scale,
    assign,
    runtime,
    usage,
    free_for_workers,
  };
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
  const { desired, scale, free_for_workers } = planElasticity(planInput);

  const agentSeq = { value: input.runtime.agent_seq };
  const assignOpts = buildAssignOptions(input, limits, now, agentSeq);
  if (input.max_assign === undefined) {
    assignOpts.max_assign = free_for_workers;
  }

  const assign = await assignReadyTasksAsync(assignOpts);
  const runtime = finalizeRuntime(
    input,
    assign,
    scale,
    now,
    agentSeq.value,
  );
  const usage = computeSlotUsage(runtime.sessions);
  updateMetrics(input.metrics, desired, usage, scale);

  return {
    desired_workers: desired,
    scale,
    assign,
    runtime,
    usage,
    free_for_workers,
  };
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
