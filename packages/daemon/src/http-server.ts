import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { API_MAJOR, DEFAULT_HOST } from "./paths.js";
import {
  EventBus,
  appendEventJsonl,
  createEvent,
  type EventEnvelope,
} from "./events.js";
import type { ProjectRegistry, RegisteredProject } from "./project-registry.js";

export interface DaemonHttpContext {
  registry: ProjectRegistry;
  bus: EventBus;
  token: string;
  startedAt: string;
  host: string;
  port: number;
  /** When true, require Bearer token even on loopback (tests can disable). */
  requireAuth?: boolean;
}

export interface DaemonHttpServer {
  server: Server;
  ctx: DaemonHttpContext;
  /** In-memory run stubs keyed by project id (empty until later PRs). */
  runs: Map<string, StubRun[]>;
  close(): Promise<void>;
}

export interface StubRun {
  id: string;
  project_id: string;
  phase: string;
  idea?: string;
  created_at: string;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      chunks.push(c);
    });
    req.on("end", () => {
      resolveBody(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function parseUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
}

function checkAuth(
  req: IncomingMessage,
  ctx: DaemonHttpContext,
): boolean {
  if (ctx.requireAuth === false) return true;
  // Loopback-only v1: token recommended but not required on loopback
  const remote = req.socket.remoteAddress ?? "";
  const isLoopback =
    remote === "127.0.0.1" ||
    remote === "::1" ||
    remote === "::ffff:127.0.0.1" ||
    remote === "";
  if (isLoopback && ctx.requireAuth !== true) return true;

  const header = req.headers.authorization;
  if (!header) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return false;
  return m[1] === ctx.token;
}

/**
 * Create the LazyOrch daemon HTTP server with stub routes + SSE events.
 */
export function createDaemonHttpServer(
  ctx: DaemonHttpContext,
): DaemonHttpServer {
  const runs = new Map<string, StubRun[]>();

  const server = createServer((req, res) => {
    void handleRequest(req, res, ctx, runs).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal_error", message: msg });
      } else {
        res.end();
      }
    });
  });

  return {
    server,
    ctx,
    runs,
    close: () =>
      new Promise((resolveClose, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolveClose();
        });
      }),
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: DaemonHttpContext,
  runs: Map<string, StubRun[]>,
): Promise<void> {
  const url = parseUrl(req);
  const method = (req.method ?? "GET").toUpperCase();
  const path = url.pathname.replace(/\/+$/, "") || "/";

  // CORS-ish for local GUI dev
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Last-Event-ID");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health is always public
  if (method === "GET" && (path === "/health" || path === "/v1/health")) {
    sendJson(res, 200, {
      ok: true,
      status: "healthy",
      api_major: API_MAJOR,
      host: ctx.host,
      port: ctx.port,
      started_at: ctx.startedAt,
      pid: process.pid,
    });
    return;
  }

  if (!checkAuth(req, ctx)) {
    sendJson(res, 401, { error: "unauthorized", message: "Bearer token required" });
    return;
  }

  // --- routes ---

  if (method === "GET" && path === "/v1/status") {
    const projects = await ctx.registry.list();
    let runCount = 0;
    for (const list of runs.values()) runCount += list.length;
    sendJson(res, 200, {
      ok: true,
      api_major: API_MAJOR,
      started_at: ctx.startedAt,
      project_count: projects.length,
      run_count: runCount,
      projects,
    });
    return;
  }

  if (method === "GET" && path === "/v1/projects") {
    const projects = await ctx.registry.list();
    sendJson(res, 200, { projects });
    return;
  }

  if (method === "POST" && path === "/v1/projects/init") {
    const raw = await readBody(req);
    let body: { repo_root?: string; id?: string; name?: string } = {};
    if (raw.trim() !== "") {
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        sendJson(res, 400, { error: "invalid_json" });
        return;
      }
    }
    if (!body.repo_root || typeof body.repo_root !== "string") {
      sendJson(res, 400, {
        error: "missing_repo_root",
        message: "body.repo_root is required",
      });
      return;
    }
    const id =
      typeof body.id === "string" && body.id.length > 0
        ? body.id
        : `proj_${randomBytes(12).toString("hex")}`;
    const regInput: { id: string; repo_root: string; name?: string } = {
      id,
      repo_root: resolve(body.repo_root),
    };
    if (typeof body.name === "string") regInput.name = body.name;
    const project = await ctx.registry.register(regInput);

    const event = createEvent({
      project_id: project.id,
      type: "project.registered",
      payload: {
        repo_root: project.repo_root,
        name: project.name ?? null,
      },
    });
    const published = ctx.bus.publish(event);
    try {
      await appendEventJsonl({
        repoRoot: project.repo_root,
        event: published,
        fsync: false,
      });
    } catch {
      // Project dir may not have .lazyorch yet — bus still fans out
    }

    sendJson(res, 200, { project });
    return;
  }

  if (method === "GET" && path === "/v1/runs") {
    const projectId = url.searchParams.get("project") ?? undefined;
    const all: StubRun[] = [];
    if (projectId) {
      all.push(...(runs.get(projectId) ?? []));
    } else {
      for (const list of runs.values()) all.push(...list);
    }
    sendJson(res, 200, { runs: all });
    return;
  }

  if (method === "GET" && path === "/v1/adapters") {
    // Stub until PR-08 adapter registry
    sendJson(res, 200, {
      adapters: [
        {
          id: "claude",
          source: "builtin",
          health: "unknown",
          capabilities: { models: true, cancel: true },
        },
        {
          id: "codex",
          source: "builtin",
          health: "unknown",
          capabilities: { models: true, cancel: true },
        },
        {
          id: "agy",
          source: "builtin",
          health: "unknown",
          capabilities: { models: true, cancel: true },
        },
        {
          id: "grok",
          source: "builtin",
          health: "unknown",
          capabilities: { models: true, cancel: true },
        },
        {
          id: "shell",
          source: "builtin",
          health: "ok",
          capabilities: { models: false, cancel: true },
        },
      ],
      stub: true,
    });
    return;
  }

  if (method === "GET" && path === "/v1/models/route") {
    // Stub dry-run complexity router
    const role = url.searchParams.get("role") ?? "worker";
    const taskId = url.searchParams.get("task") ?? undefined;
    sendJson(res, 200, {
      stub: true,
      role,
      task_id: taskId ?? null,
      tier: "standard",
      adapter_id: "claude",
      model: "default",
      reason: "routing_disabled",
    });
    return;
  }

  if (method === "GET" && path === "/v1/events") {
    await handleSse(req, res, ctx, url);
    return;
  }

  sendJson(res, 404, { error: "not_found", path, method });
}

async function handleSse(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: DaemonHttpContext,
  url: URL,
): Promise<void> {
  const projectFilter = url.searchParams.get("project") ?? undefined;

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`: connected\n\n`);

  const writeEvent = (event: EventEnvelope): void => {
    if (projectFilter && event.project_id !== projectFilter) return;
    const id = event.id ?? "";
    if (id) res.write(`id: ${id}\n`);
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const unsubscribe = ctx.bus.subscribe(writeEvent);

  // Heartbeat
  const heartbeat = setInterval(() => {
    res.write(`: ping ${Date.now()}\n\n`);
  }, 15000);

  const cleanup = (): void => {
    clearInterval(heartbeat);
    unsubscribe();
  };

  req.on("close", cleanup);
  req.on("error", cleanup);
}

/** Helper for tests: list registered projects via context. */
export type { RegisteredProject };

/** Bind host/port constants re-export for callers. */
export { DEFAULT_HOST, API_MAJOR };
