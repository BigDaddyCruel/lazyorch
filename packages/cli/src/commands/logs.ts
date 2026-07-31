/**
 * `lazyorch logs` — read durable events JSONL under `.lazyorch/events/`.
 *
 * `--follow` polls the file (simple tail); injectable read for tests.
 */
import { resolve } from "node:path";
import {
  eventJsonlPath,
  readEventJsonl,
  type EventEnvelope,
} from "@lazyorch/daemon";
import { EXIT } from "../exit-codes.js";
import { writeJson, writeLine } from "../util.js";

export interface LogsOptions {
  run?: string;
  /** When true, print raw JSONL lines (default pretty array once). */
  follow?: boolean;
  /** Max events to print (default unlimited for non-follow). */
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

  const reader = options.readEvents ?? readEventJsonl;

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
    let events = await reader(path);
    if (options.limit !== undefined && options.limit >= 0) {
      events = events.slice(-options.limit);
    }
    writeJson(
      stdout,
      {
        path,
        run_id: runId ?? null,
        count: events.length,
        events,
      },
      pretty,
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
  let seen = 0;
  let polls = 0;
  const all: EventEnvelope[] = [];

  // Initial read
  try {
    const events = await opts.reader(opts.path);
    for (const ev of events) {
      writeLine(opts.stdout, JSON.stringify(ev));
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
          writeLine(opts.stdout, JSON.stringify(ev));
          all.push(ev);
          seen += 1;
          if (opts.limit !== undefined && seen >= opts.limit) {
            return { exitCode: EXIT.OK, events: all, path: opts.path };
          }
        }
      } else {
        seen = events.length;
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
