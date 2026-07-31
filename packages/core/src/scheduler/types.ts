/**
 * Scheduler domain types (KD-19, KD-26, KD-28, elastic pool).
 *
 * Ports keep forge worktrees / path-scope locks injectable so unit tests
 * never touch real git or LLM adapters.
 */

import type {
  ElasticityConfig,
  ReserveSlotsConfig,
  SchedulingConfig,
  TeamConfig,
} from "@lazyorch/shared";
import type { RouteResult } from "../models/types.js";
import type { AgentRole } from "../types/agent.js";
import type { RunPhase } from "../types/run.js";
import type { Task } from "../types/task.js";

/** Phases that keep a lead slot reservation for scale-up free-slot math. */
export const LEAD_RESERVE_PHASES: ReadonlySet<RunPhase> = new Set([
  "Planning",
  "PlanConsensus",
  "Implementing",
]);

/** Session lifecycle for slot accounting (ephemeral agents). */
export type SchedulerSessionState =
  | "starting"
  | "running"
  | "idle"
  | "draining";

/**
 * Lightweight view of a live (or starting) agent session for slot math.
 * Matches the spirit of adapters RunningAgent without importing adapters.
 */
export interface SchedulerSession {
  run_handle: string;
  agent_id: string;
  role: AgentRole;
  /** Worker / reviewer / qa template tags (role affinity matching). */
  labels?: string[];
  task_id?: string;
  state: SchedulerSessionState;
  adapter_id?: string;
  model?: string;
  model_tier?: string | null;
  /** Last activity ms (for idle scale-down). */
  last_activity_ms: number;
  /** When true, worktree has no dirty files (scale-down gate). */
  worktree_clean?: boolean;
}

/** Snapshot of concurrent usage by role. */
export interface SlotUsage {
  /** All sessions in starting|running (lead, workers, reviewers, QA). */
  slots_used: number;
  /**
   * Worker sessions that hold a slot (starting|running).
   * Used for max_workers cap and free-slot spawn gates.
   */
  active_workers: number;
  /**
   * Worker pool size for elasticity (starting|running|idle, not draining).
   * Idle workers hold 0 slots but still count until scaled down.
   */
  pool_workers: number;
  active_reviewers: number;
  active_qa: number;
  active_lead: number;
  /** starting|running sessions only (idle configs hold 0 slots). */
  by_role: Record<AgentRole, number>;
}

export interface SlotLimits {
  max_concurrent_agents: number;
  max_workers: number;
  max_reviewers: number;
  max_qa: number;
  /** `reserve_slots.lead` (default 1). */
  reserve_slots_lead: number;
}

export interface FreeForWorkersInput {
  max_concurrent_agents: number;
  slots_used: number;
  reserve_slots_lead: number;
  /** True when a lead session is starting or running. */
  lead_session_active: boolean;
  /** True when phase is Planning / PlanConsensus / Implementing. */
  lead_reservation_needed: boolean;
}

/**
 * Path-scope lock port — compatible with forge `PathScopeLockManager`.
 * Acquisition is atomic (all keys or none).
 */
export type ScopeLockAcquireResult =
  | { ok: true; keys: string[] }
  | {
      ok: false;
      conflicts: ReadonlyArray<{
        holderId: string;
        heldKey?: unknown;
        requestedKey?: unknown;
      }>;
    };

export interface ScopeLockPort {
  tryAcquire(
    holderId: string,
    scopes: readonly string[],
  ): ScopeLockAcquireResult;
  release(holderId: string): number;
  heldBy?(holderId: string): string[];
  isHolder?(holderId: string): boolean;
  clear?(): void;
}

/**
 * Worktree lifecycle hooks (forge implements; tests inject fakes).
 * Scheduler never calls real git.
 */
export interface WorktreePaths {
  worktreePath: string;
  branch: string;
}

export interface WorktreePort {
  /**
   * Ensure a task worktree exists; return absolute path + branch name.
   * May be a no-op when workspace_mode is shared.
   */
  ensureWorktree(task: Task): Promise<WorktreePaths> | WorktreePaths;
  /** Optional clean check for scale-down. */
  isClean?(worktreePath: string): Promise<boolean> | boolean;
}

/** Host resource pressure (optional; best-effort). */
export interface HostPressure {
  mem_pct?: number;
  cpu_pct?: number;
}

/** Inputs for the deterministic desired-workers formula. */
export interface DesiredWorkersInput {
  /** Count of ready tasks not blocked by scope lock wait. */
  ready_count: number;
  /** Worker sessions in starting|running (and assigned-but-starting). */
  active_workers: number;
  elasticity: Pick<
    ElasticityConfig,
    | "min_workers"
    | "max_workers"
    | "scale_up_ready_ratio"
    | "pressure_scale_down"
  >;
  /** When true, desired = 0 (drain only). */
  budget_exhausted?: boolean;
  host?: HostPressure;
}

export type ScaleActionKind = "spawn" | "drain" | "none";

export interface ScaleDecision {
  desired: number;
  active_workers: number;
  action: ScaleActionKind;
  /** How many workers to spawn this tick (≤ scale_burst). */
  spawn_count: number;
  /** Worker run_handles selected for drain (idle + worktree_clean only). */
  drain_handles: string[];
  reason: string;
}

/** Tracks how long a ready task has failed scope-lock acquisition. */
export interface ScopeLockWait {
  task_id: string;
  first_fail_ms: number;
  last_fail_ms: number;
  conflict_holders: string[];
}

export interface AssignTaskResult {
  task: Task;
  route: RouteResult;
  worktree?: WorktreePaths;
  session_plan: {
    role: "worker";
    agent_id: string;
    adapter_id: string;
    model: string;
    model_tier: RouteResult["tier"];
    session_kind: RouteResult["session_kind"];
    effort?: RouteResult["effort"];
    complexity_score?: number;
  };
}

export type AssignSkipReason =
  | "no_slot"
  | "max_workers"
  | "scope_lock"
  | "scope_lock_blocked"
  | "skip_scope_ok"
  | "worktree_error"
  | "no_ready";

export interface AssignSkip {
  task_id: string;
  reason: AssignSkipReason;
  detail?: string;
}

export interface AssignBatchResult {
  assigned: AssignTaskResult[];
  skipped: AssignSkip[];
  /** Tasks moved ready → blocked (scope_lock wait exceeded). */
  blocked: Task[];
  /** Updated wait map after this batch. */
  scope_lock_waits: Map<string, ScopeLockWait>;
}

/**
 * Scheduler operator config subset (from shared schemas).
 * Callers pass resolved config slices.
 */
export interface SchedulerConfig {
  elasticity: ElasticityConfig;
  scheduling: SchedulingConfig;
  reserve_slots: ReserveSlotsConfig;
  team: Pick<
    TeamConfig,
    | "mode"
    | "max_reviewers"
    | "max_qa"
    | "min_reviewers"
    | "min_qa"
    | "worker_templates"
  >;
}

/** Mutable scheduler runtime state between ticks. */
export interface SchedulerRuntimeState {
  sessions: SchedulerSession[];
  /** task_id → first/last fail timestamps for scope_lock waits. */
  scope_lock_waits: Map<string, ScopeLockWait>;
  /** Last scale action timestamp (ms). */
  last_scale_ms: number;
  /** Cumulative scale events (spawn or drain). */
  scale_events: number;
  /** Monotonic agent id counter for synthetic worker agents (tests). */
  agent_seq: number;
}

export function emptySchedulerRuntime(): SchedulerRuntimeState {
  return {
    sessions: [],
    scope_lock_waits: new Map(),
    last_scale_ms: 0,
    scale_events: 0,
    agent_seq: 0,
  };
}
