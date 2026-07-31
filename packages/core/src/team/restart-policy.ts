/**
 * Lead / reviewer / QA restart policies (PR-18 recovery polish).
 *
 * Design:
 * - Clean exit (ok, idle exit, cancelled-for-idle) ≠ restart budget.
 * - Crash / timeout / stall / error exits count toward max_restarts_per_hour.
 * - After cap → human_intervention gate (caller opens gate).
 * - Lead restarts only when agent work is still pending.
 * - Reviewer/QA restarts when queue/work still pending and under cap.
 */

import {
  DEFAULT_LEAD_MAX_RESTARTS_PER_HOUR,
  DEFAULT_QA_MAX_RESTARTS_PER_HOUR,
  DEFAULT_REVIEWER_MAX_RESTARTS_PER_HOUR,
  defaultEphemeralPolicy,
  withinRestartBudget,
} from "./ephemeral.js";
import type { EphemeralSessionPolicy } from "./types.js";

export type RestartRole = "lead" | "reviewer" | "qa";

/** Session exit statuses that count toward the rolling restart budget. */
export const RESTART_COUNTABLE_STATUSES = [
  "error",
  "timeout",
  "stall",
] as const;

export type RestartCountableStatus =
  (typeof RESTART_COUNTABLE_STATUSES)[number];

/**
 * Statuses that are clean exits (do not count).
 * `cancelled` is clean when reason is idle/user drain; callers may override.
 */
export const CLEAN_EXIT_STATUSES = ["ok", "cancelled"] as const;

export function isRestartCountableStatus(
  status: string,
): status is RestartCountableStatus {
  return (RESTART_COUNTABLE_STATUSES as readonly string[]).includes(status);
}

export function isCleanExitStatus(status: string): boolean {
  return (CLEAN_EXIT_STATUSES as readonly string[]).includes(status);
}

/**
 * Whether this exit should count toward max_restarts_per_hour.
 *
 * - error / timeout / stall → always count
 * - ok → never
 * - cancelled → count only when `count_cancelled` (crash-forced cancel path)
 */
export function countsTowardRestartBudget(
  status: string,
  options?: { count_cancelled?: boolean },
): boolean {
  if (isRestartCountableStatus(status)) return true;
  if (status === "cancelled" && options?.count_cancelled === true) return true;
  return false;
}

export interface RestartEvent {
  at_ms: number;
  status: string;
  counted: boolean;
  run_handle?: string;
}

export interface RestartBudgetTrackerOptions {
  role: RestartRole;
  max_restarts_per_hour: number;
  /** Rolling window ms (default 1 hour). */
  window_ms?: number;
  now?: () => number;
}

/**
 * Rolling-hour restart counter for one role (lead / reviewer / qa).
 * Clean exits are recorded for observability but do not count.
 */
export class RestartBudgetTracker {
  readonly role: RestartRole;
  readonly max_restarts_per_hour: number;
  readonly window_ms: number;
  private readonly now: () => number;
  private readonly events: RestartEvent[] = [];

  constructor(options: RestartBudgetTrackerOptions) {
    this.role = options.role;
    this.max_restarts_per_hour = options.max_restarts_per_hour;
    this.window_ms = options.window_ms ?? 3_600_000;
    this.now = options.now ?? Date.now;
  }

  /**
   * Record a session exit. Returns whether it counted and if restart is still allowed.
   */
  recordExit(
    status: string,
    options?: {
      at_ms?: number;
      run_handle?: string;
      count_cancelled?: boolean;
    },
  ): {
    counted: boolean;
    restarts_last_hour: number;
    within_budget: boolean;
    should_human_intervention: boolean;
  } {
    const at_ms = options?.at_ms ?? this.now();
    const countOpts =
      options?.count_cancelled !== undefined
        ? { count_cancelled: options.count_cancelled }
        : undefined;
    const counted = countsTowardRestartBudget(status, countOpts);
    const event: RestartEvent = {
      at_ms,
      status,
      counted,
    };
    if (options?.run_handle !== undefined) {
      event.run_handle = options.run_handle;
    }
    this.events.push(event);
    this.prune(at_ms);

    const restarts_last_hour = this.restartsLastHour(at_ms);
    const within_budget = withinRestartBudget(
      restarts_last_hour,
      this.max_restarts_per_hour,
    );
    return {
      counted,
      restarts_last_hour,
      within_budget,
      should_human_intervention: counted && !within_budget,
    };
  }

  restartsLastHour(atMs?: number): number {
    const t = atMs ?? this.now();
    this.prune(t);
    return this.events.filter((e) => e.counted).length;
  }

  /** True when under the cap (another crash restart is allowed). */
  canRestart(atMs?: number): boolean {
    return withinRestartBudget(
      this.restartsLastHour(atMs),
      this.max_restarts_per_hour,
    );
  }

  /** True when the last countable exit exhausted the budget. */
  shouldOpenHumanIntervention(atMs?: number): boolean {
    return !this.canRestart(atMs) && this.restartsLastHour(atMs) > 0;
  }

  listEvents(): readonly RestartEvent[] {
    return this.events;
  }

  private prune(atMs: number): void {
    const cutoff = atMs - this.window_ms;
    while (this.events.length > 0 && (this.events[0]?.at_ms ?? 0) < cutoff) {
      this.events.shift();
    }
  }
}

export interface RoleRestartConfig {
  lead?: { max_restarts_per_hour?: number; idle_exit_ms?: number };
  reviewer?: { max_restarts_per_hour?: number; idle_exit_ms?: number };
  qa?: { max_restarts_per_hour?: number };
}

/** Build EphemeralSessionPolicy from operator lead/reviewer/qa config sections. */
export function ephemeralPolicyFromConfig(
  role: RestartRole,
  config?: RoleRestartConfig,
): EphemeralSessionPolicy {
  const section =
    role === "lead"
      ? config?.lead
      : role === "reviewer"
        ? config?.reviewer
        : config?.qa;
  const overrides: Partial<EphemeralSessionPolicy> = {};
  if (section?.max_restarts_per_hour !== undefined) {
    overrides.max_restarts_per_hour = section.max_restarts_per_hour;
  }
  if (
    role !== "qa" &&
    section &&
    "idle_exit_ms" in section &&
    typeof section.idle_exit_ms === "number"
  ) {
    overrides.idle_exit_ms = section.idle_exit_ms;
  }
  return defaultEphemeralPolicy(role, overrides);
}

/** Defaults for each role's restart cap (design config). */
export function defaultMaxRestartsPerHour(role: RestartRole): number {
  switch (role) {
    case "lead":
      return DEFAULT_LEAD_MAX_RESTARTS_PER_HOUR;
    case "reviewer":
      return DEFAULT_REVIEWER_MAX_RESTARTS_PER_HOUR;
    case "qa":
      return DEFAULT_QA_MAX_RESTARTS_PER_HOUR;
  }
}

export interface CanRestartLeadInput {
  /** Crash/timeout restarts in the rolling hour. */
  restarts_last_hour: number;
  max_restarts_per_hour: number;
  /** Lead agent work still pending (not just integrate queue). */
  agent_work_pending: boolean;
}

/**
 * Lead may restart only if agent work is pending and under restart cap.
 * Clean exits never reach this (caller only invokes on crash/timeout).
 */
export function canRestartLead(input: CanRestartLeadInput): boolean {
  if (!input.agent_work_pending) return false;
  return withinRestartBudget(
    input.restarts_last_hour,
    input.max_restarts_per_hour,
  );
}

export interface CanRestartReviewerInput {
  restarts_last_hour: number;
  max_restarts_per_hour: number;
  /** Tasks still in review / needs_re_review. */
  review_queue_nonempty: boolean;
}

export function canRestartReviewer(input: CanRestartReviewerInput): boolean {
  if (!input.review_queue_nonempty) return false;
  return withinRestartBudget(
    input.restarts_last_hour,
    input.max_restarts_per_hour,
  );
}

export interface CanRestartQaInput {
  restarts_last_hour: number;
  max_restarts_per_hour: number;
  qa_work_pending: boolean;
}

export function canRestartQa(input: CanRestartQaInput): boolean {
  if (!input.qa_work_pending) return false;
  return withinRestartBudget(
    input.restarts_last_hour,
    input.max_restarts_per_hour,
  );
}

/**
 * Unified decision after an ephemeral session exit.
 * Caller records the exit on RestartBudgetTracker first (or passes counts).
 */
export function decideEphemeralRestart(params: {
  role: RestartRole;
  exit_status: string;
  restarts_last_hour: number;
  max_restarts_per_hour: number;
  work_pending: boolean;
  count_cancelled?: boolean;
}): {
  counted: boolean;
  should_restart: boolean;
  human_intervention: boolean;
  reason: string;
} {
  const counted = countsTowardRestartBudget(
    params.exit_status,
    params.count_cancelled !== undefined
      ? { count_cancelled: params.count_cancelled }
      : undefined,
  );

  if (!counted) {
    return {
      counted: false,
      should_restart: false,
      human_intervention: false,
      reason: "clean_exit",
    };
  }

  if (!params.work_pending) {
    return {
      counted: true,
      should_restart: false,
      human_intervention: false,
      reason: "no_work_pending",
    };
  }

  // restarts_last_hour should already include this exit if counted
  const within = withinRestartBudget(
    params.restarts_last_hour,
    params.max_restarts_per_hour,
  );

  if (!within) {
    return {
      counted: true,
      should_restart: false,
      human_intervention: true,
      reason: "restart_budget_exhausted",
    };
  }

  return {
    counted: true,
    should_restart: true,
    human_intervention: false,
    reason: "restart",
  };
}
