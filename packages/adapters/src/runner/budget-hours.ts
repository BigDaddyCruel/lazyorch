/**
 * Budget hours stub (PR-07).
 * Tracks elapsed session wall-clock hours; hard-stop hook.
 * USD aggregation lands in PR-18; hours/concurrency always enforceable (KD-24).
 */

export interface BudgetHoursLimits {
  max_agent_hours?: number | null;
  max_run_hours?: number | null;
  hard_stop?: boolean;
}

export interface SessionHoursEntry {
  run_handle: string;
  started_at_ms: number;
  ended_at_ms?: number;
  /** Open session still running when ended_at_ms is unset. */
}

export interface BudgetHoursSnapshot {
  run_id: string;
  run_started_at_ms: number;
  /** Sum of closed sessions + currently open sessions (wall clock). */
  agent_hours: number;
  /** Wall clock since run start. */
  run_hours: number;
  open_sessions: number;
  closed_sessions: number;
}

export type BudgetStopReason =
  | "max_agent_hours"
  | "max_run_hours"
  | "none";

export interface BudgetHardStopResult {
  should_stop: boolean;
  reason: BudgetStopReason;
  hard_stop: boolean;
  snapshot: BudgetHoursSnapshot;
  message: string;
}

export interface BudgetHoursTrackerOptions {
  run_id: string;
  run_started_at_ms?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

/**
 * In-memory (per run) tracker of agent session hours.
 * Persist/restore is the scheduler's concern; this is the pure accounting stub.
 */
export class BudgetHoursTracker {
  readonly run_id: string;
  readonly run_started_at_ms: number;
  private readonly now: () => number;
  private readonly sessions = new Map<string, SessionHoursEntry>();

  constructor(options: BudgetHoursTrackerOptions) {
    this.run_id = options.run_id;
    this.now = options.now ?? Date.now;
    this.run_started_at_ms = options.run_started_at_ms ?? this.now();
  }

  recordSessionStart(runHandle: string, startedAtMs?: number): void {
    const started_at_ms = startedAtMs ?? this.now();
    this.sessions.set(runHandle, {
      run_handle: runHandle,
      started_at_ms,
    });
  }

  recordSessionEnd(runHandle: string, endedAtMs?: number): void {
    const existing = this.sessions.get(runHandle);
    const ended_at_ms = endedAtMs ?? this.now();
    if (!existing) {
      // Session we never saw start — still record zero-duration close.
      this.sessions.set(runHandle, {
        run_handle: runHandle,
        started_at_ms: ended_at_ms,
        ended_at_ms,
      });
      return;
    }
    this.sessions.set(runHandle, {
      ...existing,
      ended_at_ms,
    });
  }

  /** Elapsed agent-hours (sum of session wall times, open sessions counted to now). */
  agentHoursUsed(atMs?: number): number {
    const t = atMs ?? this.now();
    let ms = 0;
    for (const s of this.sessions.values()) {
      const end = s.ended_at_ms ?? t;
      ms += Math.max(0, end - s.started_at_ms);
    }
    return ms / 3_600_000;
  }

  runHoursElapsed(atMs?: number): number {
    const t = atMs ?? this.now();
    return Math.max(0, t - this.run_started_at_ms) / 3_600_000;
  }

  snapshot(atMs?: number): BudgetHoursSnapshot {
    const t = atMs ?? this.now();
    let open = 0;
    let closed = 0;
    for (const s of this.sessions.values()) {
      if (s.ended_at_ms === undefined) open += 1;
      else closed += 1;
    }
    return {
      run_id: this.run_id,
      run_started_at_ms: this.run_started_at_ms,
      agent_hours: this.agentHoursUsed(t),
      run_hours: this.runHoursElapsed(t),
      open_sessions: open,
      closed_sessions: closed,
    };
  }

  /**
   * Hard-stop check. When hard_stop is true (default) and a limit is exceeded,
   * should_stop is true — caller cancels sessions and fails the run.
   */
  checkHardStop(
    limits: BudgetHoursLimits,
    atMs?: number,
  ): BudgetHardStopResult {
    const snapshot = this.snapshot(atMs);
    const hard_stop = limits.hard_stop !== false;

    const maxAgent = limits.max_agent_hours;
    if (
      maxAgent !== undefined &&
      maxAgent !== null &&
      snapshot.agent_hours >= maxAgent
    ) {
      return {
        should_stop: hard_stop,
        reason: "max_agent_hours",
        hard_stop,
        snapshot,
        message: `agent hours ${snapshot.agent_hours.toFixed(4)}h >= max_agent_hours ${maxAgent}`,
      };
    }

    const maxRun = limits.max_run_hours;
    if (
      maxRun !== undefined &&
      maxRun !== null &&
      snapshot.run_hours >= maxRun
    ) {
      return {
        should_stop: hard_stop,
        reason: "max_run_hours",
        hard_stop,
        snapshot,
        message: `run hours ${snapshot.run_hours.toFixed(4)}h >= max_run_hours ${maxRun}`,
      };
    }

    return {
      should_stop: false,
      reason: "none",
      hard_stop,
      snapshot,
      message: "within budget hours",
    };
  }
}
