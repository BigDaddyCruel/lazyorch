/**
 * Shared session runner (KD-40).
 * Owns: materialize prompt/meta, sessions.json pid table, timeout/stall,
 * process-tree cancel, result parse → task FSM mapping hooks.
 * Adapters only map AgentSession → argv/env/stdio.
 */

import { randomBytes } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { killProcessTree } from "../process-tree.js";
import { scrubEnv } from "../scrub.js";
import type {
  AgentAdapter,
  AgentSession,
  RunningAgent,
  SessionRecord,
  SessionResult,
  SessionStatus,
} from "../types.js";
import {
  BudgetHoursTracker,
  type BudgetHardStopResult,
  type BudgetHoursLimits,
} from "./budget-hours.js";
import {
  materializeSession,
  type MaterializeOptions,
  type SkillLoader,
} from "./materialize.js";
import {
  mapSessionResultToTaskEffect,
  type MapResultOptions,
  type TaskFsmEffect,
} from "./result-map.js";
import { resolveStructuredDecision } from "./result-parse.js";
import {
  registerSession,
  sessionDirFor,
  sessionsFilePath,
  updateSessionRecord,
} from "./sessions-table.js";

export class SessionRunnerError extends Error {
  readonly code:
    | "budget_hard_stop"
    | "missing_adapter"
    | "materialize"
    | "start";

  constructor(code: SessionRunnerError["code"], message: string) {
    super(message);
    this.name = "SessionRunnerError";
    this.code = code;
  }
}

export interface SessionRunnerOptions {
  /** Absolute path to runs/<run_id>/ */
  run_dir: string;
  run_id: string;
  /** Resolve adapter by id. */
  getAdapter: (adapterId: string) => AgentAdapter | undefined;
  stall_timeout_ms?: number;
  cancel_grace_ms?: number;
  /** Poll interval for stall log growth (ms). Default 250. */
  stall_poll_ms?: number;
  skill_loader?: SkillLoader;
  skill_markdown?: Record<string, string>;
  budget?: BudgetHoursLimits;
  budget_tracker?: BudgetHoursTracker;
  /** Injectable clock. */
  now?: () => number;
  /** Injectable process-tree kill (tests). */
  killTree?: (pid: number) => Promise<void>;
  /**
   * When true, stall monitor is enabled (default true if stall_timeout_ms > 0).
   */
  enable_stall?: boolean;
}

export interface StartSessionParams {
  session: AgentSession;
  /** Optional fixed handle (tests); otherwise generated. */
  run_handle?: string;
  /** Consecutive invalid parse count for result→FSM mapping. */
  invalid_parse_count?: number;
  cancel_reason?: string;
}

export interface ManagedRunningAgent extends RunningAgent {
  /** Request cancel; process-tree kill after adapter cancel best-effort. */
  cancel(reason?: string): Promise<void>;
  /** Result → task FSM effect after wait() settles. */
  taskEffect(): TaskFsmEffect | undefined;
  /** Raw wait promise already started (same as wait). */
}

export interface SessionRunner {
  readonly run_dir: string;
  readonly run_id: string;
  readonly budget_tracker: BudgetHoursTracker;
  start(params: StartSessionParams): Promise<ManagedRunningAgent>;
  checkBudget(): BudgetHardStopResult;
  /** Cancel all live managed sessions (budget hard-stop / run cancel). */
  cancelAll(reason?: string): Promise<void>;
}

export function generateRunHandle(): string {
  return `ses_${randomBytes(12).toString("hex")}`;
}

export function createSessionRunner(
  options: SessionRunnerOptions,
): SessionRunner {
  return new SessionRunnerImpl(options);
}

class SessionRunnerImpl implements SessionRunner {
  readonly run_dir: string;
  readonly run_id: string;
  readonly budget_tracker: BudgetHoursTracker;
  private readonly getAdapter: SessionRunnerOptions["getAdapter"];
  private readonly stall_timeout_ms: number;
  private readonly cancel_grace_ms: number;
  private readonly stall_poll_ms: number;
  private readonly skill_loader?: SkillLoader;
  private readonly skill_markdown?: Record<string, string>;
  private readonly budget: BudgetHoursLimits;
  private readonly now: () => number;
  private readonly killTree: (pid: number) => Promise<void>;
  private readonly enable_stall: boolean;
  private readonly live = new Map<string, ManagedState>();

  constructor(options: SessionRunnerOptions) {
    this.run_dir = options.run_dir;
    this.run_id = options.run_id;
    this.getAdapter = options.getAdapter;
    this.stall_timeout_ms = options.stall_timeout_ms ?? 600_000;
    this.cancel_grace_ms = options.cancel_grace_ms ?? 30_000;
    this.stall_poll_ms = options.stall_poll_ms ?? 250;
    if (options.skill_loader !== undefined) {
      this.skill_loader = options.skill_loader;
    }
    if (options.skill_markdown !== undefined) {
      this.skill_markdown = options.skill_markdown;
    }
    this.budget = options.budget ?? {};
    this.now = options.now ?? Date.now;
    this.killTree =
      options.killTree ?? ((pid) => killProcessTree(pid));
    this.enable_stall =
      options.enable_stall ?? this.stall_timeout_ms > 0;
    this.budget_tracker =
      options.budget_tracker ??
      new BudgetHoursTracker({
        run_id: options.run_id,
        now: this.now,
      });
  }

  checkBudget(): BudgetHardStopResult {
    return this.budget_tracker.checkHardStop(this.budget, this.now());
  }

  async cancelAll(reason = "cancel_all"): Promise<void> {
    const handles = [...this.live.keys()];
    await Promise.all(
      handles.map((h) => this.live.get(h)?.cancel(reason) ?? Promise.resolve()),
    );
  }

  async start(params: StartSessionParams): Promise<ManagedRunningAgent> {
    const stop = this.checkBudget();
    if (stop.should_stop) {
      throw new SessionRunnerError(
        "budget_hard_stop",
        `budget hard-stop: ${stop.message}`,
      );
    }

    const adapter = this.getAdapter(params.session.adapter_id);
    if (!adapter) {
      throw new SessionRunnerError(
        "missing_adapter",
        `no adapter registered for id "${params.session.adapter_id}"`,
      );
    }

    const run_handle = params.run_handle ?? generateRunHandle();
    const session_dir = sessionDirFor(this.run_dir, run_handle);
    await mkdir(session_dir, { recursive: true });

    const started_at_ms = this.now();
    const started_at = new Date(started_at_ms).toISOString();

    const scrubbedSession: AgentSession = {
      ...params.session,
      env: scrubEnv(params.session.env),
      session_dir,
    };

    let materialized;
    try {
      const matOpts: MaterializeOptions = {
        session_dir,
        run_handle,
        session: scrubbedSession,
        started_at,
      };
      if (this.skill_loader !== undefined) {
        matOpts.skill_loader = this.skill_loader;
      }
      if (this.skill_markdown !== undefined) {
        matOpts.skill_markdown = this.skill_markdown;
      }
      materialized = await materializeSession(matOpts);
    } catch (err) {
      throw new SessionRunnerError(
        "materialize",
        `materialize failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const sessionForStart: AgentSession = {
      ...scrubbedSession,
      session_dir: materialized.session_dir,
      prompt_file: materialized.prompt_file,
    };

    let agent: RunningAgent;
    try {
      agent = await adapter.start(sessionForStart);
    } catch (err) {
      throw new SessionRunnerError(
        "start",
        `adapter.start failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Register in sessions.json before returning to scheduler (KD-40).
    const record: SessionRecord = {
      run_handle,
      pid: agent.pid,
      adapter_id: agent.adapter_id,
      agent_id: agent.agent_id,
      role: params.session.role,
      started_at: agent.started_at || started_at,
      session_dir: agent.session_dir,
      log_path: agent.log_path,
      status: "running",
    };
    if (agent.task_id !== undefined) record.task_id = agent.task_id;
    await registerSession(sessionsFilePath(this.run_dir), record);

    this.budget_tracker.recordSessionStart(run_handle, started_at_ms);

    const state: ManagedState = {
      run_handle,
      pid: agent.pid,
      adapter,
      agent,
      session: sessionForStart,
      invalid_parse_count: params.invalid_parse_count ?? 0,
      cancelled: false,
      cancel: async () => undefined,
    };
    if (params.cancel_reason !== undefined) {
      state.cancel_reason = params.cancel_reason;
    }

    const managed = this.wrapAgent(state);
    this.live.set(run_handle, state);
    return managed;
  }

  private wrapAgent(state: ManagedState): ManagedRunningAgent {
    const cancel = async (reason = "cancel"): Promise<void> => {
      if (state.cancelled || state.terminalStatus) return;
      state.cancelled = true;
      state.cancel_reason = reason;
      try {
        await state.adapter.cancel(state.run_handle);
      } catch {
        // best-effort
      }
      // Cooperative grace (default 30s); tests inject cancel_grace_ms: 0.
      if (this.cancel_grace_ms > 0) {
        await sleep(this.cancel_grace_ms);
      }
      await this.killTree(state.pid);
      state.terminalStatus = "cancelled";
    };
    state.cancel = cancel;

    const wait = async (): Promise<SessionResult> => {
      if (state.waitPromise) return state.waitPromise;
      state.waitPromise = this.monitorWait(state);
      try {
        return await state.waitPromise;
      } finally {
        this.live.delete(state.run_handle);
      }
    };

    const managed: ManagedRunningAgent = {
      run_handle: state.run_handle,
      pid: state.pid,
      adapter_id: state.agent.adapter_id,
      agent_id: state.agent.agent_id,
      session_dir: state.agent.session_dir,
      started_at: state.agent.started_at,
      log_path: state.agent.log_path,
      wait,
      cancel,
      taskEffect: () => state.taskEffect,
    };
    if (state.agent.task_id !== undefined) {
      managed.task_id = state.agent.task_id;
    }
    return managed;
  }

  private async monitorWait(state: ManagedState): Promise<SessionResult> {
    const timeoutMs = state.session.timeout_ms;
    let settled = false;
    let forcedStatus: SessionStatus | undefined;
    const abort = { stopped: false };

    const forceKill = async (status: SessionStatus): Promise<void> => {
      if (settled) return;
      forcedStatus = status;
      state.terminalStatus = status;
      try {
        await state.adapter.cancel(state.run_handle);
      } catch {
        // ignore
      }
      await this.killTree(state.pid);
    };

    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    type RaceWinner =
      | { kind: "exit"; r: SessionResult }
      | { kind: "timeout" }
      | { kind: "stall" }
      | { kind: "cancelled" };

    const agentWait: Promise<RaceWinner> = state.agent
      .wait()
      .then((r) => ({ kind: "exit" as const, r }));

    const races: Promise<RaceWinner>[] = [agentWait];

    if (timeoutMs > 0) {
      races.push(
        new Promise<RaceWinner>((resolve) => {
          timeoutTimer = setTimeout(
            () => resolve({ kind: "timeout" }),
            timeoutMs,
          );
        }),
      );
    }

    if (this.enable_stall && this.stall_timeout_ms > 0) {
      races.push(this.watchStall(state, abort));
    }

    races.push(this.watchCancel(state, abort));

    let winner: RaceWinner;
    try {
      winner = await Promise.race(races);
      if (winner.kind === "timeout") {
        await forceKill("timeout");
        void state.agent.wait().catch(() => undefined);
      } else if (winner.kind === "stall") {
        await forceKill("stall");
        void state.agent.wait().catch(() => undefined);
      } else if (winner.kind === "cancelled") {
        void state.agent.wait().catch(() => undefined);
      }
    } finally {
      settled = true;
      abort.stopped = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
    }

    let result: SessionResult;
    if (winner.kind === "exit" && !forcedStatus && !state.cancelled) {
      result = winner.r;
    } else if (forcedStatus === "timeout" || winner.kind === "timeout") {
      result = {
        status: "timeout",
        adapter_id: state.agent.adapter_id,
        summary: `session exceeded timeout_ms=${timeoutMs}`,
      };
    } else if (forcedStatus === "stall" || winner.kind === "stall") {
      result = {
        status: "stall",
        adapter_id: state.agent.adapter_id,
        summary: `session stalled (no log growth for ${this.stall_timeout_ms}ms)`,
      };
    } else {
      result = {
        status: "cancelled",
        adapter_id: state.agent.adapter_id,
        summary: state.cancel_reason ?? "cancelled",
      };
    }

    // Enrich with structured decision when process left artifacts.
    if (result.decision === undefined) {
      const { decision, raw_result_path } = await resolveStructuredDecision(
        state.agent.session_dir,
      );
      if (decision) {
        result = { ...result, decision };
      }
      if (raw_result_path) {
        result = { ...result, raw_result_path };
      }
    }

    const mapOpts: MapResultOptions = {
      role: state.session.role,
      session_kind: state.session.session_kind,
      result,
      invalid_parse_count: state.invalid_parse_count,
      attempt: state.session.context.task?.attempt ?? 0,
      max_attempts: state.session.context.task?.max_attempts ?? 3,
    };
    if (state.cancel_reason !== undefined) {
      mapOpts.cancel_reason = state.cancel_reason;
    }
    state.taskEffect = mapSessionResultToTaskEffect(mapOpts);

    const ended_at = new Date(this.now()).toISOString();
    this.budget_tracker.recordSessionEnd(state.run_handle, this.now());

    await updateSessionRecord(sessionsFilePath(this.run_dir), state.run_handle, {
      status: result.status,
      ended_at,
    });

    return result;
  }

  private async watchStall(
    state: ManagedState,
    abort: { stopped: boolean },
  ): Promise<{ kind: "stall" }> {
    const logPath = state.agent.log_path;
    let lastSize = -1;
    let lastChange = this.now();

    while (!abort.stopped) {
      try {
        const s = await stat(logPath);
        if (s.size !== lastSize) {
          lastSize = s.size;
          lastChange = this.now();
        }
      } catch {
        if (lastSize < 0) {
          lastSize = 0;
          lastChange = this.now();
        }
      }
      if (this.now() - lastChange >= this.stall_timeout_ms) {
        return { kind: "stall" };
      }
      await sleep(this.stall_poll_ms);
    }
    // Aborted because another race won — never resolve as stall.
    return new Promise(() => undefined);
  }

  private async watchCancel(
    state: ManagedState,
    abort: { stopped: boolean },
  ): Promise<{ kind: "cancelled" }> {
    while (!abort.stopped) {
      if (state.cancelled && state.terminalStatus === "cancelled") {
        return { kind: "cancelled" };
      }
      await sleep(25);
    }
    return new Promise(() => undefined);
  }
}

interface ManagedState {
  run_handle: string;
  pid: number;
  adapter: AgentAdapter;
  agent: RunningAgent;
  session: AgentSession;
  invalid_parse_count: number;
  cancel_reason?: string;
  terminalStatus?: SessionStatus;
  taskEffect?: TaskFsmEffect;
  waitPromise?: Promise<SessionResult>;
  cancelled: boolean;
  cancel: (reason?: string) => Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Path helpers re-exported for callers. */
export function projectRunDir(projectRoot: string, runId: string): string {
  return join(projectRoot, ".lazyorch", "runs", runId);
}
