/**
 * Thin generic CLI adapter — start_template → argv spawn.
 * Used for user-registered tools (aider, opencode, …).
 * First-class builtins use CodingCliAdapter (PR-09).
 *
 * Does not own timeout/stall/cancel process-tree kill (session runner).
 * No usage parse (stdio.log capture only) — see design thin matrix.
 *
 * Example registry entries: USER_ADAPTER_TEMPLATES in user-templates.ts
 * (aider, opencode). Register via config adapters.registry[] or
 * `lazyorch adapter register --id … --binary … --start-template "…"`.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { scrubEnv } from "../scrub.js";
import type {
  AgentAdapter,
  AgentSession,
  DoctorResult,
  RunningAgent,
  SessionResult,
} from "../types.js";
import { probeAdapter, type ExecImpl } from "./probe.js";
import type { AdapterRegistration } from "./types.js";
import type { SpawnImpl, SpawnedProcess } from "../shell/adapter.js";
import { defaultSpawnImpl } from "../shell/adapter.js";
import { resolveModelList } from "../coding/models-probe.js";

export class GenericAdapterError extends Error {
  readonly code:
    | "unbound"
    | "missing_template"
    | "missing_session_dir"
    | "spawn"
    | "empty_argv";

  constructor(code: GenericAdapterError["code"], message: string) {
    super(message);
    this.name = "GenericAdapterError";
    this.code = code;
  }
}

export interface GenericAdapterOptions {
  registration: AdapterRegistration;
  spawnImpl?: SpawnImpl;
  execImpl?: ExecImpl;
}

interface LiveEntry {
  process: SpawnedProcess;
  run_handle: string;
}

export interface TemplateVars {
  cwd: string;
  model: string;
  prompt_file: string;
  session_dir: string;
  timeout_ms: number | string;
  binary?: string;
  args_prefix?: readonly string[];
  agent_id?: string;
  task_id?: string;
}

/**
 * Split a template string into argv tokens (respects quotes in the template).
 * Does **not** expand placeholders — use {@link templateToArgv} for path-safe
 * substitution (values with spaces stay single argv entries).
 */
export function splitTemplateArgv(command: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    const part = m[1] ?? m[2] ?? m[3] ?? "";
    if (part.length > 0 || m[1] !== undefined || m[2] !== undefined) {
      out.push(part);
    }
  }
  return out;
}

/**
 * Build argv from start_template without re-splitting substituted values.
 * Tokens the template as whitespace/quoted segments first, then replaces
 * `{placeholder}` wholly or in-place — so `C:\Program Files\...` stays one arg.
 */
export function templateToArgv(
  template: string,
  vars: TemplateVars,
): string[] {
  const map: Record<string, string> = {
    "{cwd}": vars.cwd,
    "{model}": vars.model,
    "{prompt_file}": vars.prompt_file,
    "{session_dir}": vars.session_dir,
    "{timeout_ms}": String(vars.timeout_ms),
    "{binary}": vars.binary ?? "",
    "{args_prefix}": (vars.args_prefix ?? []).join(" "),
    "{agent_id}": vars.agent_id ?? "",
    "{task_id}": vars.task_id ?? "",
  };

  const rawTokens = splitTemplateArgv(template);
  const argv: string[] = [];

  for (const tok of rawTokens) {
    // Whole-token placeholder: expand {args_prefix} to multiple argv entries.
    if (tok === "{args_prefix}") {
      for (const a of vars.args_prefix ?? []) {
        if (a.length > 0) argv.push(a);
      }
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(map, tok)) {
      argv.push(map[tok] ?? "");
      continue;
    }
    // In-token substitution (e.g. --prompt={prompt_file}) — no re-split.
    let out = tok;
    for (const [ph, val] of Object.entries(map)) {
      if (out.includes(ph)) {
        out = out.split(ph).join(val);
      }
    }
    argv.push(out);
  }

  return argv;
}

export class GenericCliAdapter implements AgentAdapter {
  readonly id: string;
  private readonly reg: AdapterRegistration;
  private readonly spawnImpl: SpawnImpl;
  private readonly execImpl: ExecImpl | undefined;
  private readonly live = new Map<string, LiveEntry>();

  constructor(options: GenericAdapterOptions) {
    this.reg = options.registration;
    this.id = options.registration.id;
    this.spawnImpl = options.spawnImpl ?? defaultSpawnImpl;
    this.execImpl = options.execImpl;
  }

  get registration(): AdapterRegistration {
    return this.reg;
  }

  async doctor(): Promise<DoctorResult> {
    const probeOpts = this.execImpl ? { exec: this.execImpl } : {};
    return probeAdapter(this.reg, probeOpts);
  }

  /**
   * capabilities.models → optional models_args probe → tier_map values.
   * User templates (e.g. opencode) set models_args: ["models"].
   */
  async listModels(): Promise<string[]> {
    const probeOpts = this.execImpl ? { exec: this.execImpl } : {};
    return resolveModelList(this.reg, this.reg.models_args, probeOpts);
  }

  async start(session: AgentSession): Promise<RunningAgent> {
    if (this.reg.unbound) {
      throw new GenericAdapterError(
        "unbound",
        `adapter ${this.id} is unbound — set binary path or install CLI on PATH`,
      );
    }
    if (!session.session_dir) {
      throw new GenericAdapterError(
        "missing_session_dir",
        "session_dir must be set by the session runner before adapter.start",
      );
    }
    if (!this.reg.start_template) {
      throw new GenericAdapterError(
        "missing_template",
        `adapter ${this.id} has no start_template (configure adapters.registry[].start_template)`,
      );
    }

    const binary = this.reg.binary_path ?? this.reg.binary;
    const prompt_file =
      session.prompt_file ?? join(session.session_dir, "prompt.md");
    const templateVars: TemplateVars = {
      cwd: session.cwd,
      model: session.model,
      prompt_file,
      session_dir: session.session_dir,
      timeout_ms: session.timeout_ms,
      binary,
      agent_id: session.agent_id,
    };
    if (this.reg.args_prefix) templateVars.args_prefix = this.reg.args_prefix;
    if (session.task_id !== undefined) templateVars.task_id = session.task_id;

    // Path-safe: tokenize template first, then substitute (no re-split of paths).
    let argv = templateToArgv(this.reg.start_template, templateVars);
    if (argv.length === 0) {
      throw new GenericAdapterError(
        "empty_argv",
        "start_template produced empty argv",
      );
    }
    // Ensure binary is first token when template is args-only.
    if (
      !this.reg.start_template.includes("{binary}") &&
      argv[0] !== binary
    ) {
      argv = [binary, ...(this.reg.args_prefix ?? []), ...argv];
    }

    const run_handle = extractRunHandle(session.session_dir);
    const log_path = join(session.session_dir, "stdio.log");
    await mkdir(session.session_dir, { recursive: true });

    const cleanEnv = scrubEnv({
      ...process.env,
      ...session.env,
      ...(this.reg.env ?? {}),
    });

    let spawned: SpawnedProcess;
    try {
      spawned = await this.spawnImpl({
        argv,
        cwd: session.cwd,
        env: cleanEnv,
        log_path,
        session_dir: session.session_dir,
        run_handle,
      });
    } catch (err) {
      throw new GenericAdapterError(
        "spawn",
        `failed to spawn ${this.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!Number.isFinite(spawned.pid) || spawned.pid <= 0) {
      throw new GenericAdapterError("spawn", "spawn returned invalid pid");
    }

    const started_at = new Date().toISOString();
    this.live.set(run_handle, { process: spawned, run_handle });

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
          if (signal !== null && (exit_code === null || exit_code !== 0)) {
            const result: SessionResult = {
              status: "cancelled",
              adapter_id: this.id,
              model_used: session.model,
              summary: `${this.id} killed by signal ${signal}`,
            };
            if (exit_code !== null) result.exit_code = exit_code;
            return result;
          }
          if (exit_code === null) {
            return {
              status: "cancelled",
              adapter_id: this.id,
              model_used: session.model,
              summary: `${this.id} exited without code (signal)`,
            };
          }
          const status = exit_code === 0 ? "ok" : "error";
          return {
            status,
            exit_code,
            adapter_id: this.id,
            model_used: session.model,
            summary:
              status === "ok"
                ? `${this.id} exited 0`
                : `${this.id} exited ${exit_code}`,
          };
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

export function createGenericAdapter(
  registration: AdapterRegistration,
  options: Omit<GenericAdapterOptions, "registration"> = {},
): GenericCliAdapter {
  return new GenericCliAdapter({ registration, ...options });
}
