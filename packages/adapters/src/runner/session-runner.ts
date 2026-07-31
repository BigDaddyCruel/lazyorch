/**
 * Shared session runner (KD-40).
 * Owns: materialize prompt/meta, sessions.json pid table, timeout/stall,
 * process-tree cancel, result parse → task FSM mapping hooks.
 * Adapters only map AgentSession → argv/env/stdio.
 *
 * Stall (PR-07): log-growth only on `log_path` (and optional `stallProgress`
 * pulse). Design also mentions task transitions; the scheduler can inject
 * `stallProgress` that advances when the task FSM moves. Full dual-signal
 * stall is completed when the orchestrator wires that hook.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
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
    | "start"
    | "register";

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
  /**
   * Optional progress pulse for stall detection (in addition to log size).
   * Return a number/string that changes when the session makes progress
   * (e.g. last task FSM transition id). Unchanged for `stall_timeout_ms`
   * + no log growth → stall. PR-07 default: log-growth only when omitted.
   */
  stallProgress?: () => number | string;
  skill_loader?: SkillLoader;
  skill_markdown?: Record<string, string>;
  budget?: BudgetHoursLimits;
  budget_tracker?: BudgetHoursTracker;
  /** Injectable clock. */
  now?: () => number;
  /** Injectable process-tree kill (tests). */
  killTree?: (pid: number) => Promise<void>;
  /**
   * Optional pid liveness probe during cancel grace (tests / platforms).
   * Default: process.kill(pid, 0) style check.
   */
  isPidAlive?: (pid: number) => boolean;
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
}

export interface ManagedRunningAgent extends RunningAgent {
  /**
   * Request cancel; process-tree kill after adapter cancel best-effort.
   * Pass a cancel reason for task FSM mapping, e.g.:
   * `replan_supersede` | `run_cancel` | `budget_hard_stop` | `user` | `preempt`.
   */
  cancel(reason?: string): Promise<void>;
  /** Result → task FSM effect after wait() settles. */
  taskEffect(): TaskFsmEffect | undefined;
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
  private readonly stallProgress?: () => number | string;
  private readonly skill_loader?: SkillLoader;
  private readonly skill_markdown?: Record<string, string>;
  private readonly budget: BudgetHoursLimits;
  private readonly now: () => number;
  private readonly killTree: (pid: number) => Promise<void>;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly enable_stall: boolean;
  private readonly live = new Map<string, ManagedState>();

  constructor(options: SessionRunnerOptions) {
    this.run_dir = options.run_dir;
    this.run_id = options.run_id;
    this.getAdapter = options.getAdapter;
    this.stall_timeout_ms = options.stall_timeout_ms ?? 600_000;
    this.cancel_grace_ms = options.cancel_grace_ms ?? 30_000;
    this.stall_poll_ms = options.stall_poll_ms ?? 250;
    if (options.stallProgress !== undefined) {
      this.stallProgress = options.stallProgress;
    }
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
    this.isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
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
    // If registration fails, kill the live process so we never orphan a pid.
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

    try {
      await registerSession(sessionsFilePath(this.run_dir), record);
    } catch (err) {
      try {
        await adapter.cancel(run_handle);
      } catch {
        // best-effort
      }
      try {
        await this.killTree(agent.pid);
      } catch {
        // best-effort
      }
      throw new SessionRunnerError(
        "register",
        `sessions.json register failed (process killed): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

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
      // Cooperative grace before force tree-kill; exit early if pid is dead.
      await this.waitGraceOrDead(state.pid, this.cancel_grace_ms);
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

  /** Sleep up to grace_ms, returning early when pid is no longer alive. */
  private async waitGraceOrDead(pid: number, graceMs: number): Promise<void> {
    if (graceMs <= 0) return;
    const deadline = this.now() + graceMs;
    const slice = Math.min(50, graceMs);
    while (this.now() < deadline) {
      if (!this.isPidAlive(pid)) return;
      const remaining = deadline - this.now();
      await sleep(Math.min(slice, remaining));
    }
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
        summary: `session stalled (no log/progress for ${this.stall_timeout_ms}ms)`,
      };
    } else {
      result = {
        status: "cancelled",
        adapter_id: state.agent.adapter_id,
        summary: state.cancel_reason ?? "cancelled",
      };
    }

    // Enrich with structured decision: result.json then last stdout JSON line
    // from stdio.log (KD-40 structured sources).
    if (result.decision === undefined) {
      const stdout = await readLogBestEffort(state.agent.log_path);
      const resolved = await resolveStructuredDecision(
        state.agent.session_dir,
        stdout,
      );
      if (resolved.decision) {
        result = { ...result, decision: resolved.decision };
      }
      if (resolved.raw_result_path) {
        result = { ...result, raw_result_path: resolved.raw_result_path };
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
    // Best-effort usage aggregation (PR-18): adapter-reported cost or model_rates.
    this.budget_tracker.recordUsage(
      state.run_handle,
      result.usage,
      result.model_used ?? state.session.model,
    );

    await updateSessionRecord(sessionsFilePath(this.run_dir), state.run_handle, {
      status: result.status,
      ended_at,
    });

    return result;
  }

  /**
   * Stall when neither log size nor stallProgress pulse changes for
   * stall_timeout_ms. Log-growth-only when stallProgress is omitted (PR-07).
   */
  private async watchStall(
    state: ManagedState,
    abort: { stopped: boolean },
  ): Promise<{ kind: "stall" }> {
    const logPath = state.agent.log_path;
    let lastSize = -1;
    let lastPulse: number | string | undefined =
      this.stallProgress?.() ?? undefined;
    let lastChange = this.now();

    while (!abort.stopped) {
      let progressed = false;
      try {
        const s = await stat(logPath);
        if (s.size !== lastSize) {
          lastSize = s.size;
          progressed = true;
        }
      } catch {
        if (lastSize < 0) {
          lastSize = 0;
          progressed = true;
        }
      }
      if (this.stallProgress) {
        const pulse = this.stallProgress();
        if (pulse !== lastPulse) {
          lastPulse = pulse;
          progressed = true;
        }
      }
      if (progressed) {
        lastChange = this.now();
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

function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readLogBestEffort(logPath: string): Promise<string | undefined> {
  try {
    return await readFile(logPath, "utf8");
  } catch {
    return undefined;
  }
}

/** Path helpers re-exported for callers. */
export function projectRunDir(projectRoot: string, runId: string): string {
  return join(projectRoot, ".lazyorch", "runs", runId);
}
