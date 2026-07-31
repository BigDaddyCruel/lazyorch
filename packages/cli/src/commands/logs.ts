/**
 * `lazyorch logs` — read durable events JSONL under `.lazyorch/events/`.
 *
 * **Read-only:** never mutates event files (torn last lines are skipped in
 * memory only). Daemon recovery may use mutate-on-read; CLI must not.
 *
 * **Display redaction:** stdout is passed through {@link scrubText} so common
 * token prefixes (ghp_, sk-, …) are not printed to the terminal. Durable JSONL
 * on disk is left unchanged.
 */
import { scrubText } from "@lazyorch/adapters";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { eventJsonlPath, type EventEnvelope } from "@lazyorch/daemon";
import { EXIT } from "../exit-codes.js";


export interface LogsOptions {
  run?: string;
  /** When true, print raw JSONL lines (default pretty array once). */
  follow?: boolean;
  /**
   * Max events to print from the end (non-follow) or stop after N (follow).
   * `0` means print nothing.
   */
  limit?: number;
  repo?: string;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  pretty?: boolean;
  /**
   * Inject event reader (tests).
   * Receives absolute JSONL path.
   */
  readEvents?: (path: string) => Promise<EventEnvelope[]>;
  /**
   * For follow mode: sleep between polls (ms). Default 500.
   * Tests can set 0 and provide maxPolls.
   */
  pollMs?: number;
  /** Cap follow polls (tests); omit for infinite. */
  maxPolls?: number;
  /** Resolve path without touching daemon package (tests). */
  resolvePath?: (repo: string, runId?: string) => string;
}

export interface LogsResult {
  exitCode: number;
  events: EventEnvelope[];
  path: string;
  message?: string;
}

/** Serialize for terminal display with best-effort secret redaction. */
export function formatLogsJson(value: unknown, pretty: boolean): string {
  const raw = pretty
    ? `${JSON.stringify(value, null, 2)}\n`
    : `${JSON.stringify(value)}\n`;
  return scrubText(raw);
}

/** Single JSONL/event line for follow mode (redacted). */
export function formatLogLine(line: string): string {
  return scrubText(line.endsWith("\n") ? line : `${line}\n`);
}

/**
 * Read-only JSONL parse: skip corrupt / torn lines in memory only.
 * Never writes or truncates the file.
 */
export async function readEventJsonlReadonly(
  path: string,
): Promise<EventEnvelope[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
  if (raw.length === 0) return [];

  const lines = raw.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const events: EventEnvelope[] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line) as EventEnvelope);
    } catch {
      // Drop torn/corrupt line in memory only — do not mutate the file.
    }
  }
  return events;
}

/**
 * Apply --limit: 0 → empty; n > 0 → last n events; undefined → all.
 */
export function applyEventLimit(
  events: EventEnvelope[],
  limit: number | undefined,
): EventEnvelope[] {
  if (limit === undefined) return events;
  if (limit === 0) return [];
  if (limit < 0) return events;
  return events.slice(-limit);
}

/**
 * Read project event log (JSONL).
 */
export async function runLogs(options: LogsOptions = {}): Promise<LogsResult> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const pretty = options.pretty !== false;
  const repo = resolve(options.repo ?? process.cwd());
  const runId = options.run?.trim() || undefined;

  let path: string;
  try {
    path = options.resolvePath
      ? options.resolvePath(repo, runId)
      : eventJsonlPath(repo, runId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(`error: ${msg}\n`);
    return { exitCode: EXIT.USAGE, events: [], path: "", message: msg };
  }

  // Default is read-only — never call daemon readEventJsonl (mutates on torn line).
  const reader = options.readEvents ?? readEventJsonlReadonly;

  if (options.follow === true) {
    return followLogs({
      path,
      reader,
      stdout,
      stderr,
      pollMs: options.pollMs ?? 500,
      ...(options.maxPolls !== undefined ? { maxPolls: options.maxPolls } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    });
  }

  try {
    // --limit 0: empty result without reading when possible (still ok to read)
    if (options.limit === 0) {
      stdout.write(
        formatLogsJson(
          { path, run_id: runId ?? null, count: 0, events: [] },
          pretty,
        ),
      );
      return { exitCode: EXIT.OK, events: [], path };
    }

    const events = applyEventLimit(await reader(path), options.limit);
    stdout.write(
      formatLogsJson(
        {
          path,
          run_id: runId ?? null,
          count: events.length,
          events,
        },
        pretty,
      ),
    );
    return { exitCode: EXIT.OK, events, path };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(`error: ${msg}\n`);
    return { exitCode: EXIT.ERROR, events: [], path, message: msg };
  }
}

async function followLogs(opts: {
  path: string;
  reader: (path: string) => Promise<EventEnvelope[]>;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  pollMs: number;
  maxPolls?: number;
  limit?: number;
}): Promise<LogsResult> {
  // limit 0 → emit nothing immediately
  if (opts.limit === 0) {
    return { exitCode: EXIT.OK, events: [], path: opts.path };
  }

  let seen = 0;
  let polls = 0;
  const all: EventEnvelope[] = [];

  try {
    const events = await opts.reader(opts.path);
    for (const ev of events) {
      opts.stdout.write(formatLogLine(JSON.stringify(ev)));
      all.push(ev);
      seen += 1;
      if (opts.limit !== undefined && seen >= opts.limit) {
        return { exitCode: EXIT.OK, events: all, path: opts.path };
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    opts.stderr.write(`error: ${msg}\n`);
    return { exitCode: EXIT.ERROR, events: [], path: opts.path, message: msg };
  }

  while (opts.maxPolls === undefined || polls < opts.maxPolls) {
    if (opts.pollMs > 0) {
      await sleep(opts.pollMs);
    }
    polls += 1;
    try {
      const events = await opts.reader(opts.path);
      if (events.length > seen) {
        for (const ev of events.slice(seen)) {
          opts.stdout.write(formatLogLine(JSON.stringify(ev)));
          all.push(ev);
          seen += 1;
          if (opts.limit !== undefined && seen >= opts.limit) {
            return { exitCode: EXIT.OK, events: all, path: opts.path };
          }
        }
      } else {
        // File may have been rewritten shorter — re-sync count carefully
        seen = Math.min(seen, events.length);
      }
    } catch {
      /* transient read errors while following */
    }
  }

  return { exitCode: EXIT.OK, events: all, path: opts.path };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}
