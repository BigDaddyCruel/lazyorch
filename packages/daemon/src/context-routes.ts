/**
 * Shared context KV HTTP handlers (PR-14).
 * Durable store: `<repo>/.lazyorch/runs/<run_id>/context.json` via StateStore.
 *
 * Write ACL (HTTP):
 * - PUT/DELETE require a valid Bearer token (even on loopback).
 * - Authenticated requests with no role header → `human` (CLI/GUI).
 * - `X-LazyOrch-Actor-Role` is still client-asserted for lead/worker until
 *   server-side session identity lands (TODO: bind to sessions.json).
 * Mutations for a given runId are serialized in-process (lost-update guard).
 */
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ContextKvError,
  StateStore,
  assertCanWriteContext,
  assertValidContextKey,
  getContextValue,
  isContextActorRole,
  listContextKeys,
  type ContextActorRole,
  type RunContext,
} from "@lazyorch/core";
import { parseConfigYaml } from "@lazyorch/shared";
import type { RegisteredProject, ProjectRegistry } from "./project-registry.js";

export interface ResolvedRunContext {
  project: RegisteredProject;
  store: StateStore;
  runId: string;
}

export type ResolveRunContextResult =
  | { status: "ok"; resolved: ResolvedRunContext }
  | { status: "not_found" }
  | { status: "ambiguous"; project_ids: string[] };

export interface WorkerWriteOptions {
  /** Override for tests; when omitted, load project config.yml. */
  workerWrite?: boolean;
}

/** In-process per-run mutation chain (daemon multi-writer safety). */
const contextWriteChains = new Map<string, Promise<unknown>>();

/**
 * Serialize async mutations for a single run id within this process.
 */
export function withContextWriteLock<T>(
  runId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = contextWriteChains.get(runId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  // Keep map entry until this chain settles so concurrent callers queue.
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  contextWriteChains.set(runId, settled);
  void settled.then(() => {
    // Drop only if we are still the tail (avoid clobbering newer chains).
    if (contextWriteChains.get(runId) === settled) {
      contextWriteChains.delete(runId);
    }
  });
  return next;
}

/**
 * Locate a run's state store among registered projects.
 * Prefer `projectId` when provided; otherwise scan registry.
 * Returns `ambiguous` when the same run id exists in multiple projects.
 */
export async function resolveRunContextStore(
  registry: ProjectRegistry,
  runId: string,
  projectId?: string,
): Promise<ResolveRunContextResult> {
  if (!isSafeRunId(runId)) return { status: "not_found" };

  const projects = await registry.list();
  const candidates = projectId
    ? projects.filter((p) => p.id === projectId)
    : projects;

  if (projectId && candidates.length === 0) {
    return { status: "not_found" };
  }

  const matches: ResolvedRunContext[] = [];
  for (const project of candidates) {
    const stateRoot = join(project.repo_root, ".lazyorch");
    const store = new StateStore(stateRoot);
    const run = await store.readRun(runId);
    if (run) {
      matches.push({ project, store, runId });
    }
  }

  if (matches.length === 0) return { status: "not_found" };
  if (matches.length > 1) {
    return {
      status: "ambiguous",
      project_ids: matches.map((m) => m.project.id).sort(),
    };
  }
  return { status: "ok", resolved: matches[0]! };
}

function isSafeRunId(runId: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(runId) && runId.length > 0 && runId.length <= 128;
}

/**
 * Parse actor role from `X-LazyOrch-Actor-Role`.
 * Missing header → `human` only when `bearerOk` (authenticated). Without
 * bearer, missing header is an error for write paths (callers use
 * {@link resolveWriteActor}).
 */
export function parseActorRoleSafe(
  header: string | string[] | undefined,
  options: { bearerOk: boolean } = { bearerOk: false },
): { ok: true; role: ContextActorRole } | { ok: false; message: string } {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined || (typeof raw === "string" && raw.trim() === "")) {
    if (options.bearerOk) {
      return { ok: true, role: "human" };
    }
    return {
      ok: false,
      message: "actor role requires Bearer authentication for default human",
    };
  }
  if (typeof raw !== "string") {
    return { ok: false, message: "invalid X-LazyOrch-Actor-Role header" };
  }
  const normalized = raw.trim().toLowerCase();
  if (!isContextActorRole(normalized)) {
    return {
      ok: false,
      message: `invalid actor role: ${JSON.stringify(raw)} (expected system|human|lead|worker|reviewer|qa|plan_writer|plan_reviewer)`,
    };
  }
  return { ok: true, role: normalized };
}

/**
 * Resolve write actor for HTTP context mutations.
 * Requires valid Bearer; defaults role to human when header omitted.
 *
 * Note: role claims remain client-asserted until session identity binds
 * `X-LazyOrch-Actor-Role` to sessions.json — Bearer gates open write abuse
 * on loopback without auth.
 */
export function resolveWriteActor(
  roleHeader: string | string[] | undefined,
  bearerOk: boolean,
):
  | { ok: true; role: ContextActorRole }
  | { ok: false; status: 401 | 400; error: string; message: string } {
  if (!bearerOk) {
    return {
      ok: false,
      status: 401,
      error: "unauthorized",
      message:
        "context writes require Bearer token (even on loopback); role is not trusted without auth",
    };
  }
  const parsed = parseActorRoleSafe(roleHeader, { bearerOk: true });
  if (!parsed.ok) {
    return {
      ok: false,
      status: 400,
      error: "invalid_actor_role",
      message: parsed.message,
    };
  }
  return { ok: true, role: parsed.role };
}

/** Load `context.worker_write` from project config.yml (default false). */
export async function loadWorkerWrite(
  repoRoot: string,
  override?: boolean,
): Promise<boolean> {
  if (typeof override === "boolean") return override;
  const configPath = join(repoRoot, ".lazyorch", "config.yml");
  try {
    await access(configPath);
    const raw = await readFile(configPath, "utf8");
    const result = parseConfigYaml(raw, { enforcePacking: false });
    return result.config.context.worker_write === true;
  } catch {
    return false;
  }
}

export function contextHttpStatus(err: ContextKvError): number {
  switch (err.code) {
    case "forbidden":
      return 403;
    case "not_found":
      return 404;
    case "invalid_key":
    case "invalid_value":
      return 400;
    case "value_too_large":
    case "quota_exceeded":
      return 413;
    default:
      return 400;
  }
}

export function listContextResponse(ctx: RunContext) {
  const keys = listContextKeys(ctx);
  return {
    run_id: ctx.run_id,
    updated_at: ctx.updated_at,
    keys,
    kv: Object.fromEntries(keys.map((k) => [k, ctx.kv[k]])),
  };
}

export function getContextResponse(ctx: RunContext, key: string) {
  assertValidContextKey(key);
  if (!Object.prototype.hasOwnProperty.call(ctx.kv, key)) {
    throw new ContextKvError("not_found", `context key not found: ${key}`);
  }
  return {
    run_id: ctx.run_id,
    key,
    value: getContextValue(ctx, key),
    updated_at: ctx.updated_at,
  };
}

export async function putContextKey(
  store: StateStore,
  runId: string,
  key: string,
  value: unknown,
  role: ContextActorRole,
  workerWrite: boolean,
): Promise<RunContext> {
  assertCanWriteContext(role, workerWrite);
  return store.setContextKey(runId, key, value);
}

export async function deleteContextKey(
  store: StateStore,
  runId: string,
  key: string,
  role: ContextActorRole,
  workerWrite: boolean,
): Promise<{ deleted: boolean }> {
  assertCanWriteContext(role, workerWrite);
  assertValidContextKey(key);
  const deleted = await store.deleteContextKey(runId, key);
  return { deleted };
}

/**
 * Match `/v1/runs/:id/context` and `/v1/runs/:id/context/:key...`
 * Key may contain `/` (namespaced keys like `model_pin/worker`).
 */
export function matchContextPath(
  path: string,
): { runId: string; key?: string } | null {
  const m = /^\/v1\/runs\/([^/]+)\/context(?:\/(.+))?$/.exec(path);
  if (!m || m[1] === undefined) return null;
  const runId = decodeURIComponent(m[1]);
  if (m[2] === undefined || m[2] === "") {
    return { runId };
  }
  let key: string;
  try {
    key = decodeURIComponent(m[2]);
  } catch {
    return null;
  }
  return { runId, key };
}
