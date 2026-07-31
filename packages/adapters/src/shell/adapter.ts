/**
 * Shell adapter — deterministic sessions only (no model tiers).
 * Maps AgentSession.command → argv spawn; runner owns timeout/stall/cancel.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  checkShellAllowlist,
  DEFAULT_SHELL_ALLOWLIST,
  type ShellAllowlistConfig,
} from "./allowlist.js";
import { scrubEnv } from "../scrub.js";
import { resolveSpawnTarget } from "../spawn-policy.js";
import type {
  AgentAdapter,
  AgentSession,
  DoctorResult,
  RunningAgent,
  SessionResult,
} from "../types.js";

export class ShellAdapterError extends Error {
  readonly code:
    | "not_deterministic"
    | "missing_command"
    | "allowlist"
    | "spawn"
    | "missing_session_dir";

  constructor(
    code: ShellAdapterError["code"],
    message: string,
  ) {
    super(message);
    this.name = "ShellAdapterError";
    this.code = code;
  }
}

export interface ShellAdapterOptions {
  allowlist?: ShellAllowlistConfig;
  /**
   * Injected spawn for tests. Must set pid and call onExit when done.
   * When omitted, uses node:child_process.spawn.
   */
  spawnImpl?: SpawnImpl;
  /**
   * Base env merged under session.env before scrub (default: `process.env`).
   * Tests inject a fake map so they never mutate global `process.env`.
   */
  baseEnv?: Record<string, string | undefined>;
}

export interface SpawnRequest {
  argv: readonly string[];
  cwd: string;
  env: Record<string, string>;
  log_path: string;
  session_dir: string;
  run_handle: string;
}

export interface SpawnedProcess {
  pid: number;
  /** Resolves with process exit code (null if signal-killed without code). */
  wait(): Promise<{ exit_code: number | null; signal: NodeJS.Signals | null }>;
  /** Best-effort terminate (SIGTERM / kill). Tree kill is runner-owned. */
  kill(): void;
}

export type SpawnImpl = (req: SpawnRequest) => Promise<SpawnedProcess>;

interface LiveEntry {
  process: SpawnedProcess;
  session: AgentSession;
  run_handle: string;
  started_at: string;
  log_path: string;
  session_dir: string;
}

export class ShellAdapter implements AgentAdapter {
  readonly id = "shell" as const;
  private readonly allowlist: ShellAllowlistConfig;
  private readonly spawnImpl: SpawnImpl;
  private readonly baseEnv: Record<string, string | undefined> | undefined;
  private readonly live = new Map<string, LiveEntry>();

  constructor(options: ShellAdapterOptions = {}) {
    this.allowlist = options.allowlist ?? DEFAULT_SHELL_ALLOWLIST;
    this.spawnImpl = options.spawnImpl ?? defaultSpawnImpl;
    this.baseEnv = options.baseEnv;
  }

  async doctor(): Promise<DoctorResult> {
    return {
      ok: true,
      adapter_id: this.id,
      message:
        "shell adapter ready (deterministic sessions; OS process spawn; no model tiers)",
      capabilities_probe: {
        models: [],
        tier_map: {},
        streaming: false,
        worktree_ok: true,
        usage_reporting: "none",
      },
    };
  }

  async listModels(): Promise<string[]> {
    return [];
  }

  async start(session: AgentSession): Promise<RunningAgent> {
    if (session.session_kind !== "deterministic") {
      throw new ShellAdapterError(
        "not_deterministic",
        "shell adapter only accepts session_kind: deterministic",
      );
    }
    if (!session.session_dir) {
      throw new ShellAdapterError(
        "missing_session_dir",
        "session_dir must be set by the session runner before adapter.start",
      );
    }
    if (!session.command || session.command.length === 0) {
      throw new ShellAdapterError(
        "missing_command",
        "deterministic shell session requires command argv",
      );
    }

    const check = checkShellAllowlist(session.command, this.allowlist);
    if (!check.ok) {
      throw new ShellAdapterError("allowlist", check.reason);
    }

    const run_handle = extractRunHandle(session.session_dir);
    const log_path = join(session.session_dir, "stdio.log");
    await mkdir(session.session_dir, { recursive: true });

    // Scrub secrets from base env (process.env or test inject) + session.env.
    // Never forward LAZYORCH_*, GH_TOKEN, AWS/DB creds, API keys, etc.
    const cleanEnv = scrubEnv({
      ...(this.baseEnv ?? process.env),
      ...session.env,
    });

    let spawned: SpawnedProcess;
    try {
      spawned = await this.spawnImpl({
        argv: session.command,
        cwd: session.cwd,
        env: cleanEnv,
        log_path,
        session_dir: session.session_dir,
        run_handle,
      });
    } catch (err) {
      throw new ShellAdapterError(
        "spawn",
        `failed to spawn shell command: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!Number.isFinite(spawned.pid) || spawned.pid <= 0) {
      throw new ShellAdapterError("spawn", "spawn returned invalid pid");
    }

    const started_at = new Date().toISOString();
    this.live.set(run_handle, {
      process: spawned,
      session,
      run_handle,
      started_at,
      log_path,
      session_dir: session.session_dir,
    });

    const agent: RunningAgent = {
      run_handle,
      pid: spawned.pid,
      adapter_id: this.id,
      agent_id: session.agent_id,
      session_dir: session.session_dir,
      started_at,
      log_path,
      wait: async (): Promise<SessionResult> => {
        try {
          const { exit_code, signal } = await spawned.wait();
          // Signal-killed (cancel/timeout tree-kill) → cancelled, not generic error.
          // Runner still overrides when it wins the timeout/stall/cancel race.
          if (signal !== null && (exit_code === null || exit_code !== 0)) {
            const result: SessionResult = {
              status: "cancelled",
              adapter_id: this.id,
              model_used: "n/a",
              summary: `shell command killed by signal ${signal}`,
            };
            if (exit_code !== null) result.exit_code = exit_code;
            return result;
          }
          if (exit_code === null) {
            return {
              status: "cancelled",
              adapter_id: this.id,
              model_used: "n/a",
              summary: "shell command exited without code (signal)",
            };
          }
          const status = exit_code === 0 ? "ok" : "error";
          return {
            status,
            exit_code,
            adapter_id: this.id,
            model_used: "n/a",
            summary:
              status === "ok"
                ? "shell command exited 0"
                : `shell command exited ${exit_code}`,
          };
        } finally {
          this.live.delete(run_handle);
        }
      },
    };
    if (session.task_id !== undefined) {
      agent.task_id = session.task_id;
    }
    return agent;
  }

  async cancel(runHandle: string): Promise<void> {
    const entry = this.live.get(runHandle);
    if (!entry) return;
    try {
      entry.process.kill();
    } catch {
      // best-effort
    }
  }
}

function extractRunHandle(sessionDir: string): string {
  const parts = sessionDir.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || "unknown";
}

/**
 * Real process spawn: argv → process, stdio → session_dir/stdio.log.
 * Windows .cmd/.bat/.ps1 rewritten via ComSpec (spawn-policy); PE/posix direct.
 * detached on non-Windows so runner can kill the process group.
 */
export async function defaultSpawnImpl(
  req: SpawnRequest,
): Promise<SpawnedProcess> {
  const [file, ...args] = req.argv;
  if (!file) {
    throw new Error("empty argv");
  }

  let logStream: WriteStream | null = createWriteStream(req.log_path, {
    flags: "a",
  });

  const target = resolveSpawnTarget(file, args);
  const child: ChildProcess = spawn(target.file, target.args, {
    cwd: req.cwd,
    env: req.env,
    windowsHide: true,
    // Process group on POSIX for tree kill; Windows uses taskkill /T.
    // Do not detach when launched via ComSpec — tree is cmd + script.
    detached: process.platform !== "win32" && !target.via_comspec,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (child.pid === undefined) {
    logStream.close();
    throw new Error("spawn did not assign a pid");
  }

  const writeLog = (chunk: string | Buffer): void => {
    if (!logStream) return;
    try {
      logStream.write(chunk);
    } catch {
      // ignore write errors after close
    }
  };

  child.stdout?.on("data", writeLog);
  child.stderr?.on("data", writeLog);

  let exitResult:
    | { exit_code: number | null; signal: NodeJS.Signals | null }
    | undefined;
  let resolveExit:
    | ((
        v: { exit_code: number | null; signal: NodeJS.Signals | null },
      ) => void)
    | undefined;

  const exitPromise = new Promise<{
    exit_code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    if (exitResult) {
      resolve(exitResult);
      return;
    }
    resolveExit = resolve;
  });

  child.on("error", (err) => {
    writeLog(`\n[spawn error] ${err.message}\n`);
    const result = { exit_code: 1 as number | null, signal: null };
    exitResult = result;
    resolveExit?.(result);
    logStream?.end();
    logStream = null;
  });

  child.on("close", (code, signal) => {
    const result = {
      exit_code: code,
      signal: signal as NodeJS.Signals | null,
    };
    exitResult = result;
    resolveExit?.(result);
    logStream?.end();
    logStream = null;
  });

  const pid = child.pid;

  return {
    pid,
    wait: () => exitPromise,
    kill: () => {
      try {
        if (process.platform === "win32") {
          child.kill();
        } else {
          try {
            process.kill(-pid, "SIGTERM");
          } catch {
            child.kill("SIGTERM");
          }
        }
      } catch {
        // already dead
      }
    },
  };
}

export function createShellAdapter(
  options?: ShellAdapterOptions,
): ShellAdapter {
  return new ShellAdapter(options);
}
