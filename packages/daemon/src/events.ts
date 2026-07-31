import { appendFile, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { EventEmitter } from "node:events";
import { SCHEMA_VERSION } from "@lazyorch/shared";
import { eventJsonlPath, projectEventsDir } from "./paths.js";

/** Event types from the design-doc EventEnvelope. */
export type EventType =
  | "phase.changed"
  | "task.updated"
  | "agent.spawned"
  | "agent.exited"
  | "gate.required"
  | "gate.resolved"
  | "plan.issue"
  | "plan.frozen"
  | "ci.check"
  | "log.line"
  | "budget.updated"
  | "model.routed"
  | "adapter.health"
  | "error"
  | "daemon.started"
  | "project.registered";

export interface EventEnvelope {
  schema_version: number;
  ts: string;
  project_id: string;
  run_id?: string;
  type: EventType | string;
  payload: Record<string, unknown>;
  /** Monotonic id within a process (optional; helpful for SSE Last-Event-ID). */
  id?: string;
}

export interface AppendEventOptions {
  /** Absolute repo root; JSONL lands under `<repo>/.lazyorch/events/`. */
  repoRoot: string;
  event: EventEnvelope;
  /** When true (default), fsync after append. */
  fsync?: boolean;
}

/**
 * Append one event as a single JSONL line under the project events dir.
 * Creates the directory as needed.
 */
export async function appendEventJsonl(
  options: AppendEventOptions,
): Promise<string> {
  const { repoRoot, event } = options;
  const fsync = options.fsync !== false;
  const path = eventJsonlPath(repoRoot, event.run_id);
  await mkdir(dirname(path), { recursive: true });
  const line = `${JSON.stringify(event)}\n`;
  if (fsync) {
    const fh = await open(path, "a");
    try {
      await fh.writeFile(line, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
  } else {
    await appendFile(path, line, "utf8");
  }
  return path;
}

/**
 * Read JSONL events from a file, dropping a torn last line if present.
 */
export async function readEventJsonl(path: string): Promise<EventEnvelope[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
  if (raw.length === 0) return [];

  const lines = raw.split("\n");
  // Drop trailing empty segment from final newline
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const events: EventEnvelope[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line) as EventEnvelope);
    } catch {
      // Torn / corrupt line: truncate file to last good content on last line
      if (i === lines.length - 1) {
        const good = lines.slice(0, i).join("\n");
        const body = good.length > 0 ? `${good}\n` : "";
        await writeFile(path, body, "utf8");
        break;
      }
      // Skip corrupt middle lines
    }
  }
  return events;
}

/** Ensure events directory exists for a project root. */
export async function ensureEventsDir(repoRoot: string): Promise<string> {
  const dir = projectEventsDir(repoRoot);
  await mkdir(dir, { recursive: true });
  return dir;
}

export function createEvent(input: {
  project_id: string;
  type: EventType | string;
  payload?: Record<string, unknown>;
  run_id?: string;
  id?: string;
  ts?: string;
}): EventEnvelope {
  const event: EventEnvelope = {
    schema_version: SCHEMA_VERSION,
    ts: input.ts ?? new Date().toISOString(),
    project_id: input.project_id,
    type: input.type,
    payload: input.payload ?? {},
  };
  if (input.run_id !== undefined) event.run_id = input.run_id;
  if (input.id !== undefined) event.id = input.id;
  return event;
}

/**
 * In-process event bus for WS/SSE fan-out.
 * Durability is separate (JSONL); this is ephemeral.
 */
export class EventBus {
  private readonly ee = new EventEmitter();
  private seq = 0;

  constructor() {
    // Avoid MaxListenersWarning with many SSE clients
    this.ee.setMaxListeners(0);
  }

  nextId(): string {
    this.seq += 1;
    return String(this.seq);
  }

  publish(event: EventEnvelope): EventEnvelope {
    const withId: EventEnvelope =
      event.id !== undefined
        ? event
        : { ...event, id: this.nextId() };
    this.ee.emit("event", withId);
    return withId;
  }

  subscribe(handler: (event: EventEnvelope) => void): () => void {
    this.ee.on("event", handler);
    return () => {
      this.ee.off("event", handler);
    };
  }
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}
