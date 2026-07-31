import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { API_MAJOR, DEFAULT_HOST } from "./paths.js";
import {
  EventBus,
  appendEventJsonl,
  createEvent,
  type EventEnvelope,
} from "./events.js";
import {
  RegistryConflictError,
  type ProjectRegistry,
  type RegisteredProject,
} from "./project-registry.js";
import { ContextKvError } from "@lazyorch/core";
import {
  contextHttpStatus,
  deleteContextKey,
  getContextResponse,
  listContextResponse,
  loadWorkerWrite,
  matchContextPath,
  parseActorRoleSafe,
  putContextKey,
  resolveRunContextStore,
} from "./context-routes.js";

/** Max JSON body size for stub POSTs (bytes). */
export const MAX_BODY_BYTES = 64 * 1024;

/** Origins allowed for local GUI / Tauri dev (reflected CORS, not *). */
const ALLOWED_ORIGINS = new Set([
  "http://127.0.0.1:1420",
  "http://localhost:1420",
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
]);

export interface DaemonHttpContext {
  registry: ProjectRegistry;
  bus: EventBus;
  token: string;
  startedAt: string;
  host: string;
  port: number;
  /** When true, require Bearer token even on loopback. */
  requireAuth?: boolean;
}

export interface DaemonHttpServer {
  server: Server;
  ctx: DaemonHttpContext;
  /** In-memory run stubs keyed by project id (empty until later PRs). */
  runs: Map<string, StubRun[]>;
  /** Active SSE responses (for clean shutdown). */
  sseClients: Set<ServerResponse>;
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

export function readBody(
  req: IncomingMessage,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let rejected = false;

    const fail = (statusError: Error & { statusCode?: number }): void => {
      if (rejected) return;
      rejected = true;
      req.destroy();
      reject(statusError);
    };

    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        const err = new Error(`Request body exceeds ${maxBytes} bytes`) as Error & {
          statusCode?: number;
        };
        err.statusCode = 413;
        fail(err);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (rejected) return;
      resolveBody(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => {
      if (!rejected) reject(err);
    });
  });
}

function parseUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
}

function isLoopbackAddress(remote: string | undefined): boolean {
  if (remote === undefined || remote === "") return false;
  return (
    remote === "127.0.0.1" ||
    remote === "::1" ||
    remote === "::ffff:127.0.0.1"
  );
}

/** Constant-time Bearer token compare (equal-length buffers). */
export function tokensEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function checkAuth(
  req: IncomingMessage,
  ctx: DaemonHttpContext,
): boolean {
  if (ctx.requireAuth === false) return true;

  const remote = req.socket.remoteAddress;
  const origin = req.headers.origin;
  // Browser requests (Origin present) always require Bearer — CSRF mitigation
  // for loopback APIs reachable from web pages.
  const forceAuth =
    ctx.requireAuth === true ||
    typeof origin === "string" ||
    !isLoopbackAddress(remote);

  if (!forceAuth) return true;

  const header = req.headers.authorization;
  if (!header) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m || m[1] === undefined) return false;
  return tokensEqual(m[1], ctx.token);
}

function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (typeof origin !== "string") return;
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, Last-Event-ID",
    );
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, DELETE, OPTIONS",
    );
  }
  // Unlisted origins get no ACAO (browser blocks). Auth still required when Origin set.
}

/**
 * Create the LazyOrch daemon HTTP server with stub routes + SSE events.
 */
export function createDaemonHttpServer(
  ctx: DaemonHttpContext,
): DaemonHttpServer {
  const runs = new Map<string, StubRun[]>();
  const sseClients = new Set<ServerResponse>();

  const server = createServer((req, res) => {
    void handleRequest(req, res, ctx, runs, sseClients).catch((err: unknown) => {
      const statusCode =
        typeof err === "object" &&
        err !== null &&
        "statusCode" in err &&
        typeof (err as { statusCode: unknown }).statusCode === "number"
          ? (err as { statusCode: number }).statusCode
          : 500;
      const msg = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        if (statusCode === 413) {
          sendJson(res, 413, { error: "payload_too_large", message: msg });
        } else {
          sendJson(res, 500, { error: "internal_error", message: msg });
        }
      } else {
        res.end();
      }
    });
  });

  return {
    server,
    ctx,
    runs,
    sseClients,
    close: () =>
      new Promise((resolveClose, reject) => {
        // End SSE streams so keep-alive sockets do not hang close()
        for (const client of sseClients) {
          try {
            client.end();
          } catch {
            /* ignore */
          }
        }
        sseClients.clear();
        if (typeof server.closeAllConnections === "function") {
          server.closeAllConnections();
        }
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
  sseClients: Set<ServerResponse>,
): Promise<void> {
  const url = parseUrl(req);
  const method = (req.method ?? "GET").toUpperCase();
  const path = url.pathname.replace(/\/+$/, "") || "/";

  applyCors(req, res);
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
    let raw: string;
    try {
      raw = await readBody(req);
    } catch (err) {
      const status =
        typeof err === "object" &&
        err !== null &&
        "statusCode" in err &&
        typeof (err as { statusCode: unknown }).statusCode === "number"
          ? (err as { statusCode: number }).statusCode
          : 500;
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, status, {
        error: status === 413 ? "payload_too_large" : "body_error",
        message: msg,
      });
      return;
    }
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

    let project;
    try {
      project = await ctx.registry.register(regInput);
    } catch (err) {
      if (err instanceof RegistryConflictError) {
        sendJson(res, 409, { error: "registry_conflict", message: err.message });
        return;
      }
      throw err;
    }

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

  // --- shared context KV: /v1/runs/:id/context[/:key] ---
  const contextMatch = matchContextPath(path);
  if (contextMatch) {
    await handleContextRequest(req, res, ctx, url, method, contextMatch);
    return;
  }

  if (method === "GET" && path === "/v1/adapters") {
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
    handleSse(req, res, ctx, url, sseClients);
    return;
  }

  sendJson(res, 404, { error: "not_found", path, method });
}

async function handleContextRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: DaemonHttpContext,
  url: URL,
  method: string,
  match: { runId: string; key?: string },
): Promise<void> {
  const projectId = url.searchParams.get("project") ?? undefined;
  const resolved = await resolveRunContextStore(
    ctx.registry,
    match.runId,
    projectId,
  );
  if (!resolved) {
    sendJson(res, 404, {
      error: "run_not_found",
      message: `run not found: ${match.runId}`,
      run_id: match.runId,
      project_id: projectId ?? null,
    });
    return;
  }

  const actor = parseActorRoleSafe(req.headers["x-lazyorch-actor-role"]);
  if (!actor.ok) {
    sendJson(res, 400, { error: "invalid_actor_role", message: actor.message });
    return;
  }

  try {
    if (method === "GET" && match.key === undefined) {
      const doc = await resolved.store.loadOrEmptyContext(resolved.runId);
      sendJson(res, 200, listContextResponse(doc));
      return;
    }

    if (method === "GET" && match.key !== undefined) {
      const doc = await resolved.store.loadOrEmptyContext(resolved.runId);
      sendJson(res, 200, getContextResponse(doc, match.key));
      return;
    }

    if (method === "PUT" && match.key !== undefined) {
      let raw: string;
      try {
        raw = await readBody(req);
      } catch (err) {
        const status =
          typeof err === "object" &&
          err !== null &&
          "statusCode" in err &&
          typeof (err as { statusCode: unknown }).statusCode === "number"
            ? (err as { statusCode: number }).statusCode
            : 500;
        const msg = err instanceof Error ? err.message : String(err);
        sendJson(res, status, {
          error: status === 413 ? "payload_too_large" : "body_error",
          message: msg,
        });
        return;
      }
      let body: { value?: unknown } = {};
      if (raw.trim() !== "") {
        try {
          body = JSON.parse(raw) as typeof body;
        } catch {
          sendJson(res, 400, { error: "invalid_json" });
          return;
        }
      }
      if (!body || typeof body !== "object" || !("value" in body)) {
        sendJson(res, 400, {
          error: "missing_value",
          message: 'body must be { "value": ... }',
        });
        return;
      }
      const workerWrite = await loadWorkerWrite(resolved.project.repo_root);
      const doc = await putContextKey(
        resolved.store,
        resolved.runId,
        match.key,
        body.value,
        actor.role,
        workerWrite,
      );
      sendJson(res, 200, {
        run_id: doc.run_id,
        key: match.key,
        value: doc.kv[match.key],
        updated_at: doc.updated_at,
      });
      return;
    }

    if (method === "DELETE" && match.key !== undefined) {
      const workerWrite = await loadWorkerWrite(resolved.project.repo_root);
      const result = await deleteContextKey(
        resolved.store,
        resolved.runId,
        match.key,
        actor.role,
        workerWrite,
      );
      if (!result.deleted) {
        sendJson(res, 404, {
          error: "not_found",
          message: `context key not found: ${match.key}`,
          key: match.key,
        });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        run_id: resolved.runId,
        key: match.key,
        deleted: true,
      });
      return;
    }

    sendJson(res, 405, {
      error: "method_not_allowed",
      message: `${method} not allowed on this context path`,
      method,
      path: url.pathname,
    });
  } catch (err) {
    if (err instanceof ContextKvError) {
      sendJson(res, contextHttpStatus(err), {
        error: err.code,
        message: err.message,
      });
      return;
    }
    throw err;
  }
}

function handleSse(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: DaemonHttpContext,
  url: URL,
  sseClients: Set<ServerResponse>,
): void {
  const projectFilter = url.searchParams.get("project") ?? undefined;

  // Last-Event-ID / ?after= JSONL replay is deferred past PR-06 (ephemeral bus only).
  // Clients reconnect with a fresh live stream; durable history remains in project JSONL.
  void req.headers["last-event-id"];
  void url.searchParams.get("after");

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`: connected\n\n`);
  // Note: Last-Event-ID replay not implemented in PR-06 — live events only.

  sseClients.add(res);

  const writeEvent = (event: EventEnvelope): void => {
    if (projectFilter && event.project_id !== projectFilter) return;
    if (res.writableEnded) return;
    const id = event.id ?? "";
    if (id) res.write(`id: ${id}\n`);
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const unsubscribe = ctx.bus.subscribe(writeEvent);

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(`: ping ${Date.now()}\n\n`);
    }
  }, 15000);

  const cleanup = (): void => {
    clearInterval(heartbeat);
    unsubscribe();
    sseClients.delete(res);
  };

  req.on("close", cleanup);
  req.on("error", cleanup);
  res.on("close", cleanup);
}

/** Helper for tests: list registered projects via context. */
export type { RegisteredProject };

/** Bind host/port constants re-export for callers. */
export { DEFAULT_HOST, API_MAJOR };
