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
  private readonly live = new Map<string, LiveEntry>();

  constructor(options: ShellAdapterOptions = {}) {
    this.allowlist = options.allowlist ?? DEFAULT_SHELL_ALLOWLIST;
    this.spawnImpl = options.spawnImpl ?? defaultSpawnImpl;
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

    const env = scrubEnv({
      ...process.env,
      ...session.env,
      // Force no model identity for shell
      LAZYORCH_SESSION_KIND: "deterministic",
    });
    // Scrub again after merge (process.env may contain secrets)
    const cleanEnv = scrubEnv(env);

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
          const { exit_code } = await spawned.wait();
          const code = exit_code ?? 1;
          const status = code === 0 ? "ok" : "error";
          const result: SessionResult = {
            status,
            exit_code: code,
            adapter_id: this.id,
            model_used: "n/a",
            summary:
              status === "ok"
                ? "shell command exited 0"
                : `shell command exited ${code}`,
          };
          return result;
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
 * Real process spawn: argv direct (no shell), stdio → session_dir/stdio.log.
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

  const child: ChildProcess = spawn(file, args, {
    cwd: req.cwd,
    env: req.env,
    windowsHide: true,
    // Process group on POSIX for tree kill; Windows uses taskkill /T.
    detached: process.platform !== "win32",
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
