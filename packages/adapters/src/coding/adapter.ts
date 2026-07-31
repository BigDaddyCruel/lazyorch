/**
 * First-class coding CLI adapter (claude / codex / agy / grok).
 * Maps AgentSession → argv/env/stdio; runner owns timeout/stall/tree-kill.
 *
 * Modes: live | fake | record (see fake.ts).
 * Best-effort usage parse from stdio.log (PR-22: JSONL/cache/cost depth).
 * listModels: capabilities.models → optional models_args probe → tier_map.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scrubCodingSpawnEnv } from "../scrub.js";
import type {
  AgentAdapter,
  AgentSession,
  DoctorResult,
  RunningAgent,
  SessionResult,
  Usage,
} from "../types.js";
import { probeAdapter, type ExecImpl } from "../registry/probe.js";
import type { AdapterRegistration } from "../registry/types.js";
import type { SpawnImpl, SpawnedProcess } from "../shell/adapter.js";
import { defaultSpawnImpl } from "../shell/adapter.js";
import { buildCodingArgv, CodingArgvError } from "./argv.js";
import {
  defaultFakeResult,
  modeAllowsUnbound,
  resolveRunMode,
  type CodingRunMode,
  type FakeSessionResultFactory,
  type RecordedStart,
  type StartRecorder,
} from "./fake.js";
import {
  getCodingProfile,
  type CodingAdapterProfile,
  type FirstClassCodingId,
} from "./profiles.js";
import { parseUsageFromLog } from "./usage.js";
import { resolveModelList } from "./models-probe.js";

export class CodingAdapterError extends Error {
  readonly code:
    | "unbound"
    | "missing_session_dir"
    | "unknown_profile"
    | "spawn"
    | "empty_argv"
    | "missing_model"
    | "not_llm";

  constructor(code: CodingAdapterError["code"], message: string) {
    super(message);
    this.name = "CodingAdapterError";
    this.code = code;
  }
}

export interface CodingAdapterOptions {
  registration: AdapterRegistration;
  profile?: CodingAdapterProfile;
  spawnImpl?: SpawnImpl;
  execImpl?: ExecImpl;
  /** live (default) | fake | record */
  mode?: CodingRunMode;
  /** Fake-mode result; default ok with tiny usage. */
  fakeResult?: SessionResult | FakeSessionResultFactory;
  /** Collect recorded starts (fake + record modes, and optional live). */
  recorder?: StartRecorder;
  /** Also record live starts when recorder set. Default true if recorder. */
  recordLive?: boolean;
  /**
   * Prefer registration.start_template over profile argv.
   * Default: only when template differs from profile default.
   */
  prefer_template?: boolean;
  /** Skip reading stdio.log for usage (tests). */
  skip_usage_parse?: boolean;
  /** Fake pid sequence start (fake mode). */
  fakePid?: number;
}

interface LiveEntry {
  process: SpawnedProcess | null;
  run_handle: string;
  mode: CodingRunMode;
}

export class CodingCliAdapter implements AgentAdapter {
  readonly id: string;
  private readonly reg: AdapterRegistration;
  private readonly profile: CodingAdapterProfile;
  private readonly spawnImpl: SpawnImpl;
  private readonly execImpl: ExecImpl | undefined;
  private readonly mode: CodingRunMode;
  private readonly fakeResult: SessionResult | FakeSessionResultFactory;
  private readonly recorder: StartRecorder | undefined;
  private readonly recordLive: boolean;
  private readonly prefer_template: boolean | undefined;
  private readonly skip_usage_parse: boolean;
  private fakePidCounter: number;
  private readonly live = new Map<string, LiveEntry>();

  constructor(options: CodingAdapterOptions) {
    this.reg = options.registration;
    this.id = options.registration.id;
    const profile =
      options.profile ?? getCodingProfile(options.registration.id);
    if (!profile) {
      throw new CodingAdapterError(
        "unknown_profile",
        `no coding profile for adapter id "${options.registration.id}"`,
      );
    }
    this.profile = profile;
    this.spawnImpl = options.spawnImpl ?? defaultSpawnImpl;
    this.execImpl = options.execImpl;
    this.mode = resolveRunMode(options.mode);
    this.fakeResult = options.fakeResult ?? defaultFakeResult;
    this.recorder = options.recorder;
    this.recordLive = options.recordLive ?? Boolean(options.recorder);
    this.prefer_template = options.prefer_template;
    this.skip_usage_parse = options.skip_usage_parse === true;
    this.fakePidCounter = options.fakePid ?? 50_000;
  }

  get registration(): AdapterRegistration {
    return this.reg;
  }

  get codingProfile(): CodingAdapterProfile {
    return this.profile;
  }

  get runMode(): CodingRunMode {
    return this.mode;
  }

  async doctor(): Promise<DoctorResult> {
    if (this.mode === "fake") {
      return {
        ok: true,
        adapter_id: this.id,
        message: `adapter ${this.id}: fake mode (no live binary required)`,
        binary_path: this.reg.binary_path ?? this.reg.binary,
        version: "fake",
        capabilities_probe: {
          ...this.reg.capabilities,
          mode: "fake",
        },
      };
    }
    const probeOpts = this.execImpl ? { exec: this.execImpl } : {};
    return probeAdapter(this.reg, probeOpts);
  }

  /**
   * Configured models first; else live probe via models_args (registration or
   * profile); else unique tier_map values. Fake mode skips the live probe.
   */
  async listModels(): Promise<string[]> {
    const modelsArgs =
      this.reg.models_args ??
      (this.profile.models_args
        ? [...this.profile.models_args]
        : undefined);
    const probeOpts: {
      skip_probe?: boolean;
      exec?: ExecImpl;
    } = {
      skip_probe: this.mode === "fake" || this.reg.unbound === true,
    };
    if (this.execImpl) probeOpts.exec = this.execImpl;
    return resolveModelList(this.reg, modelsArgs, probeOpts);
  }

  /**
   * Build argv for session without starting (tests / dry-run).
   * Wraps {@link CodingArgvError} as {@link CodingAdapterError}.
   */
  buildArgv(session: AgentSession): string[] {
    const opts: Parameters<typeof buildCodingArgv>[0] = {
      profile: this.profile,
      registration: this.reg,
      session,
    };
    if (this.prefer_template !== undefined) {
      opts.prefer_template = this.prefer_template;
    }
    try {
      return buildCodingArgv(opts);
    } catch (err) {
      if (err instanceof CodingArgvError) {
        throw new CodingAdapterError(err.code, err.message);
      }
      throw err;
    }
  }

  async start(session: AgentSession): Promise<RunningAgent> {
    if (session.session_kind === "deterministic") {
      throw new CodingAdapterError(
        "not_llm",
        `coding adapter ${this.id} only accepts session_kind: llm (use shell for deterministic)`,
      );
    }
    // live + record require a bound binary; fake may run unbound (CI).
    if (this.reg.unbound && !modeAllowsUnbound(this.mode)) {
      throw new CodingAdapterError(
        "unbound",
        `adapter ${this.id} is unbound — set binary path or install CLI on PATH`,
      );
    }
    if (!session.session_dir) {
      throw new CodingAdapterError(
        "missing_session_dir",
        "session_dir must be set by the session runner before adapter.start",
      );
    }

    let argv: string[];
    try {
      argv = this.buildArgv(session);
    } catch (err) {
      if (err instanceof CodingAdapterError) throw err;
      throw err;
    }
    if (argv.length === 0) {
      throw new CodingAdapterError(
        "empty_argv",
        "coding adapter produced empty argv",
      );
    }

    const run_handle = extractRunHandle(session.session_dir);
    const log_path = join(session.session_dir, "stdio.log");
    await mkdir(session.session_dir, { recursive: true });

    const recorded: RecordedStart = {
      adapter_id: this.id,
      run_handle,
      argv: [...argv],
      cwd: session.cwd,
      model: session.model,
      session_dir: session.session_dir,
      started_at: new Date().toISOString(),
      mode: this.mode,
    };
    if (session.prompt_file) recorded.prompt_file = session.prompt_file;
    else recorded.prompt_file = join(session.session_dir, "prompt.md");

    if (this.mode === "fake" || this.mode === "record" || this.recordLive) {
      this.recorder?.record(recorded);
    }

    // Persist argv for operator inspection (all modes).
    try {
      await writeFile(
        join(session.session_dir, "argv.json"),
        `${JSON.stringify({ argv, mode: this.mode, model: session.model }, null, 2)}\n`,
        "utf8",
      );
    } catch {
      // non-fatal
    }

    if (this.mode === "fake") {
      return this.startFake(session, run_handle, log_path, recorded);
    }

    return this.startLive(session, run_handle, log_path, argv, recorded);
  }

  private async startFake(
    session: AgentSession,
    run_handle: string,
    log_path: string,
    recorded: RecordedStart,
  ): Promise<RunningAgent> {
    const pid = this.fakePidCounter++;
    const started_at = recorded.started_at;
    this.live.set(run_handle, { process: null, run_handle, mode: "fake" });

    // Write a minimal log so usage parse / stall probes have a file.
    try {
      await writeFile(
        log_path,
        `[fake ${this.id}] model=${session.model} argv=${JSON.stringify(recorded.argv)}\n`,
        "utf8",
      );
    } catch {
      // ignore
    }

    const agent: RunningAgent = {
      run_handle,
      pid,
      adapter_id: this.id,
      agent_id: session.agent_id,
      session_dir: session.session_dir!,
      started_at,
      log_path,
      wait: async (): Promise<SessionResult> => {
        try {
          const factory = this.fakeResult;
          const result =
            typeof factory === "function"
              ? factory(session, recorded)
              : { ...factory, adapter_id: this.id, model_used: session.model };
          return result;
        } finally {
          this.live.delete(run_handle);
        }
      },
    };
    if (session.task_id !== undefined) agent.task_id = session.task_id;
    return agent;
  }

  private async startLive(
    session: AgentSession,
    run_handle: string,
    log_path: string,
    argv: string[],
    recorded: RecordedStart,
  ): Promise<RunningAgent> {
    // Preserve vendor API keys for live CLIs; still scrub orchestrator secrets.
    const cleanEnv = scrubCodingSpawnEnv(
      process.env,
      session.env,
      this.reg.env,
    );

    let spawned: SpawnedProcess;
    try {
      spawned = await this.spawnImpl({
        argv,
        cwd: session.cwd,
        env: cleanEnv,
        log_path,
        session_dir: session.session_dir!,
        run_handle,
      });
    } catch (err) {
      throw new CodingAdapterError(
        "spawn",
        `failed to spawn ${this.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!Number.isFinite(spawned.pid) || spawned.pid <= 0) {
      throw new CodingAdapterError("spawn", "spawn returned invalid pid");
    }

    const started_at = recorded.started_at;
    this.live.set(run_handle, {
      process: spawned,
      run_handle,
      mode: this.mode,
    });

    const skipUsage = this.skip_usage_parse;
    const adapterId = this.id;
    const model = session.model;

    const agent: RunningAgent = {
      run_handle,
      pid: spawned.pid,
      adapter_id: this.id,
      agent_id: session.agent_id,
      session_dir: session.session_dir!,
      started_at,
      log_path,
      wait: async (): Promise<SessionResult> => {
        try {
          const { exit_code, signal } = await spawned.wait();
          if (signal !== null && (exit_code === null || exit_code !== 0)) {
            const result: SessionResult = {
              status: "cancelled",
              adapter_id: adapterId,
              model_used: model,
              summary: `${adapterId} killed by signal ${signal}`,
            };
            if (exit_code !== null) result.exit_code = exit_code;
            return result;
          }
          if (exit_code === null) {
            return {
              status: "cancelled",
              adapter_id: adapterId,
              model_used: model,
              summary: `${adapterId} exited without code (signal)`,
            };
          }

          const status = exit_code === 0 ? "ok" : "error";
          const result: SessionResult = {
            status,
            exit_code,
            adapter_id: adapterId,
            model_used: model,
            summary:
              status === "ok"
                ? `${adapterId} exited 0`
                : `${adapterId} exited ${exit_code}`,
          };

          if (!skipUsage) {
            const usage = await parseUsageFromLog(log_path);
            if (usage) result.usage = usage;
          }

          return result;
        } finally {
          this.live.delete(run_handle);
        }
      },
    };
    if (session.task_id !== undefined) agent.task_id = session.task_id;
    return agent;
  }

  async cancel(runHandle: string): Promise<void> {
    const entry = this.live.get(runHandle);
    if (!entry) return;
    if (entry.process) {
      try {
        entry.process.kill();
      } catch {
        // best-effort
      }
    }
    // fake mode: wait() still resolves; runner may tree-kill noop pid
  }
}

function extractRunHandle(sessionDir: string): string {
  const parts = sessionDir.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || "unknown";
}

export function createCodingAdapter(
  registration: AdapterRegistration,
  options: Omit<CodingAdapterOptions, "registration"> = {},
): CodingCliAdapter {
  return new CodingCliAdapter({ registration, ...options });
}

export function createCodingAdapterForId(
  id: FirstClassCodingId,
  registration: AdapterRegistration,
  options: Omit<CodingAdapterOptions, "registration" | "profile"> = {},
): CodingCliAdapter {
  const profile = getCodingProfile(id);
  if (!profile) {
    throw new CodingAdapterError(
      "unknown_profile",
      `no coding profile for "${id}"`,
    );
  }
  return new CodingCliAdapter({ registration, profile, ...options });
}

/** Re-export Usage type for adapters that attach usage. */
export type { Usage };
