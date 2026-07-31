/**
 * Fake / record modes for coding adapters (CI without live LLMs).
 *
 * - live:   spawn real binary via SpawnImpl; requires bound binary
 * - fake:   no real process; return canned SessionResult; still builds argv;
 *           unbound adapters allowed (CI without installed CLIs)
 * - record: like live (real spawn path), but captures RecordedStart entries
 *           (pair with inject spawnImpl in tests to avoid network). Requires
 *           bound binary — same unbound gate as live.
 */

import type { AgentSession, SessionResult } from "../types.js";

export type CodingRunMode = "live" | "fake" | "record";

/** True when mode may run without a resolved binary (fake only). */
export function modeAllowsUnbound(mode: CodingRunMode): boolean {
  return mode === "fake";
}

export interface RecordedStart {
  adapter_id: string;
  run_handle: string;
  argv: readonly string[];
  cwd: string;
  model: string;
  prompt_file?: string;
  session_dir: string;
  started_at: string;
  mode: CodingRunMode;
}

export interface FakeSessionResultFactory {
  (session: AgentSession, recorded: RecordedStart): SessionResult;
}

export function defaultFakeResult(
  session: AgentSession,
  _recorded: RecordedStart,
): SessionResult {
  return {
    status: "ok",
    exit_code: 0,
    adapter_id: session.adapter_id,
    model_used: session.model,
    summary: `fake ${session.adapter_id} completed`,
    usage: {
      input_tokens: 10,
      output_tokens: 20,
    },
  };
}

/** Mutable recorder for tests / CI fixtures. */
export class StartRecorder {
  readonly entries: RecordedStart[] = [];

  record(entry: RecordedStart): void {
    this.entries.push(entry);
  }

  clear(): void {
    this.entries.length = 0;
  }

  last(): RecordedStart | undefined {
    return this.entries[this.entries.length - 1];
  }

  byAdapter(id: string): RecordedStart[] {
    return this.entries.filter((e) => e.adapter_id === id);
  }
}

/**
 * Resolve run mode from options or env LAZYORCH_ADAPTER_MODE.
 * Env is only read when options.mode is omitted (tests pass mode explicitly).
 */
export function resolveRunMode(
  mode?: CodingRunMode,
  env: NodeJS.ProcessEnv = process.env,
): CodingRunMode {
  if (mode) return mode;
  const fromEnv = env.LAZYORCH_ADAPTER_MODE?.trim().toLowerCase();
  if (fromEnv === "fake" || fromEnv === "record" || fromEnv === "live") {
    return fromEnv;
  }
  return "live";
}
