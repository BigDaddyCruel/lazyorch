/**
 * Shared context KV HTTP handlers (PR-14).
 * Durable store: `<repo>/.lazyorch/runs/<run_id>/context.json` via StateStore.
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

export interface WorkerWriteOptions {
  /** Override for tests; when omitted, load project config.yml. */
  workerWrite?: boolean;
}

/**
 * Locate a run's state store among registered projects.
 * Prefer `projectId` when provided; otherwise scan registry.
 */
export async function resolveRunContextStore(
  registry: ProjectRegistry,
  runId: string,
  projectId?: string,
): Promise<ResolvedRunContext | null> {
  if (!isSafeRunId(runId)) return null;

  const projects = await registry.list();
  const candidates = projectId
    ? projects.filter((p) => p.id === projectId)
    : projects;

  if (projectId && candidates.length === 0) return null;

  for (const project of candidates) {
    const stateRoot = join(project.repo_root, ".lazyorch");
    const store = new StateStore(stateRoot);
    const run = await store.readRun(runId);
    if (run) {
      return { project, store, runId };
    }
  }

  // Single-project id filter missed run.json → 404
  if (projectId) return null;

  // Fallback: if only one project is registered, allow context on missing run
  // only when run.json exists — always require run entity for consistency.
  return null;
}

function isSafeRunId(runId: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(runId) && runId.length > 0 && runId.length <= 128;
}

/**
 * Parse actor role from `X-LazyOrch-Actor-Role` header.
 * Authenticated requests without a role default to `human` (CLI/GUI).
 * Explicit unknown roles are rejected.
 */
export function parseActorRoleSafe(
  header: string | string[] | undefined,
): { ok: true; role: ContextActorRole } | { ok: false; message: string } {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined || (typeof raw === "string" && raw.trim() === "")) {
    return { ok: true, role: "human" };
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
  // Preserve `/` inside key; decode each segment carefully via full decode.
  let key: string;
  try {
    key = decodeURIComponent(m[2]);
  } catch {
    return null;
  }
  return { runId, key };
}
