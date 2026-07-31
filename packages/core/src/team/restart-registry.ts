/**
 * Multi-role restart budget registry (PR-18 recovery polish).
 * Holds per-role RestartBudgetTracker instances for lead/reviewer/qa and
 * applies decideEphemeralRestart after session exits.
 */

import {
  defaultMaxRestartsPerHour,
  decideEphemeralRestart,
  RestartBudgetTracker,
  type RestartRole,
  type RoleRestartConfig,
  ephemeralPolicyFromConfig,
} from "./restart-policy.js";

export interface RoleRestartRegistryOptions {
  config?: RoleRestartConfig;
  now?: () => number;
  window_ms?: number;
}

export interface RoleRestartDecision {
  role: RestartRole;
  counted: boolean;
  should_restart: boolean;
  human_intervention: boolean;
  reason: string;
  restarts_last_hour: number;
  max_restarts_per_hour: number;
}

/**
 * Per-run registry of restart budgets for ephemeral lead/reviewer/qa.
 */
export class RoleRestartRegistry {
  private readonly trackers = new Map<RestartRole, RestartBudgetTracker>();
  private readonly maxByRole = new Map<RestartRole, number>();
  private readonly now: () => number;
  private readonly window_ms?: number;

  constructor(options: RoleRestartRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    if (options.window_ms !== undefined) {
      this.window_ms = options.window_ms;
    }
    for (const role of ["lead", "reviewer", "qa"] as const) {
      const policy = ephemeralPolicyFromConfig(role, options.config);
      this.maxByRole.set(role, policy.max_restarts_per_hour);
      const trackerOpts: ConstructorParameters<typeof RestartBudgetTracker>[0] =
        {
          role,
          max_restarts_per_hour: policy.max_restarts_per_hour,
          now: this.now,
        };
      if (this.window_ms !== undefined) {
        trackerOpts.window_ms = this.window_ms;
      }
      this.trackers.set(role, new RestartBudgetTracker(trackerOpts));
    }
  }

  tracker(role: RestartRole): RestartBudgetTracker {
    const t = this.trackers.get(role);
    if (!t) {
      // Should never happen; construct on demand with defaults.
      const max = defaultMaxRestartsPerHour(role);
      const created = new RestartBudgetTracker({
        role,
        max_restarts_per_hour: max,
        now: this.now,
      });
      this.trackers.set(role, created);
      this.maxByRole.set(role, max);
      return created;
    }
    return t;
  }

  maxRestarts(role: RestartRole): number {
    return this.maxByRole.get(role) ?? defaultMaxRestartsPerHour(role);
  }

  /**
   * Record an ephemeral session exit and decide whether to restart or open
   * human_intervention.
   */
  onSessionExit(params: {
    role: RestartRole;
    exit_status: string;
    work_pending: boolean;
    run_handle?: string;
    count_cancelled?: boolean;
    at_ms?: number;
  }): RoleRestartDecision {
    const tracker = this.tracker(params.role);
    const recordOpts: {
      at_ms?: number;
      run_handle?: string;
      count_cancelled?: boolean;
    } = {};
    if (params.at_ms !== undefined) recordOpts.at_ms = params.at_ms;
    if (params.run_handle !== undefined) {
      recordOpts.run_handle = params.run_handle;
    }
    if (params.count_cancelled !== undefined) {
      recordOpts.count_cancelled = params.count_cancelled;
    }
    const recorded = tracker.recordExit(params.exit_status, recordOpts);
    const max = this.maxRestarts(params.role);
    const decision = decideEphemeralRestart({
      role: params.role,
      exit_status: params.exit_status,
      restarts_last_hour: recorded.restarts_last_hour,
      max_restarts_per_hour: max,
      work_pending: params.work_pending,
      ...(params.count_cancelled !== undefined
        ? { count_cancelled: params.count_cancelled }
        : {}),
    });
    return {
      role: params.role,
      counted: decision.counted,
      should_restart: decision.should_restart,
      human_intervention: decision.human_intervention,
      reason: decision.reason,
      restarts_last_hour: recorded.restarts_last_hour,
      max_restarts_per_hour: max,
    };
  }
}
