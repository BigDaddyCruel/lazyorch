import type { SchemaVersion } from "../schema.js";
import { SCHEMA_VERSION } from "../schema.js";

/**
 * Shared run context key/value store document
 * (`runs/<run_id>/context.json`).
 *
 * Flat JSON values only — never secrets (see design Skills scrubbing).
 */
export interface RunContext {
  schema_version: SchemaVersion;
  run_id: string;
  updated_at: string;
  /** Flat key → JSON-serializable value. */
  kv: Record<string, unknown>;
}

/** Roles that may attempt context writes (ACL evaluated separately). */
export const CONTEXT_ACTOR_ROLES = [
  "system",
  "human",
  "lead",
  "worker",
  "reviewer",
  "qa",
  "plan_writer",
  "plan_reviewer",
] as const;

export type ContextActorRole = (typeof CONTEXT_ACTOR_ROLES)[number];

const ROLE_SET = new Set<string>(CONTEXT_ACTOR_ROLES);

export function isContextActorRole(value: unknown): value is ContextActorRole {
  return typeof value === "string" && ROLE_SET.has(value);
}

/** Max key length (UTF-16 code units). */
export const CONTEXT_KEY_MAX_LEN = 256;

/** Max JSON-serialized value size (bytes, UTF-8). */
export const CONTEXT_VALUE_MAX_BYTES = 16 * 1024;

/** Max number of keys in a single run context document. */
export const CONTEXT_MAX_KEYS = 512;

/**
 * Max UTF-8 size of the full `kv` object when JSON-serialized
 * (keeps the "small durable store" budget).
 */
export const CONTEXT_MAX_KV_BYTES = 128 * 1024;

/**
 * Allowed key pattern: namespaced segments with `/` (e.g. `model_pin/worker`).
 * Alphanumerics, `_`, `-`, `.` per segment; no empty segments, no `..`.
 */
const KEY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export class ContextKvError extends Error {
  readonly code:
    | "invalid_key"
    | "invalid_value"
    | "value_too_large"
    | "quota_exceeded"
    | "forbidden"
    | "not_found";

  constructor(
    code: ContextKvError["code"],
    message: string,
  ) {
    super(message);
    this.name = "ContextKvError";
    this.code = code;
  }
}

/**
 * Validate a context key. Throws {@link ContextKvError} on failure.
 */
export function assertValidContextKey(key: string): void {
  if (typeof key !== "string" || key.length === 0) {
    throw new ContextKvError("invalid_key", "context key must be a non-empty string");
  }
  if (key.length > CONTEXT_KEY_MAX_LEN) {
    throw new ContextKvError(
      "invalid_key",
      `context key exceeds ${CONTEXT_KEY_MAX_LEN} characters`,
    );
  }
  if (key.startsWith("/") || key.endsWith("/")) {
    throw new ContextKvError(
      "invalid_key",
      "context key must not start or end with '/'",
    );
  }
  const segments = key.split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") {
      throw new ContextKvError(
        "invalid_key",
        "context key has empty or relative path segment",
      );
    }
    if (!KEY_SEGMENT.test(seg)) {
      throw new ContextKvError(
        "invalid_key",
        `context key segment invalid: ${JSON.stringify(seg)}`,
      );
    }
  }
}

/**
 * Ensure value is JSON-serializable and within size budget.
 */
export function assertValidContextValue(value: unknown): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new ContextKvError(
      "invalid_value",
      "context value must be JSON-serializable",
    );
  }
  if (serialized === undefined) {
    throw new ContextKvError(
      "invalid_value",
      "context value must be JSON-serializable (got undefined)",
    );
  }
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > CONTEXT_VALUE_MAX_BYTES) {
    throw new ContextKvError(
      "value_too_large",
      `context value exceeds ${CONTEXT_VALUE_MAX_BYTES} bytes`,
    );
  }
}

/**
 * Write ACL for shared context KV.
 *
 * Design: daemon/system + lead sessions always write; human CLI/GUI write
 * allowed with daemon auth; worker/reviewer/QA read-only by default.
 * When `workerWrite` is true, worker sessions may write; reviewer/QA remain
 * read-only (config key is specifically `context.worker_write`).
 */
export function canWriteContext(
  role: ContextActorRole,
  workerWrite: boolean = false,
): boolean {
  if (role === "system" || role === "human" || role === "lead") return true;
  if (role === "worker") return workerWrite === true;
  // reviewer, qa, plan_writer, plan_reviewer — read-only
  return false;
}

export function assertCanWriteContext(
  role: ContextActorRole,
  workerWrite: boolean = false,
): void {
  if (!canWriteContext(role, workerWrite)) {
    throw new ContextKvError(
      "forbidden",
      `role '${role}' cannot write context (worker_write=${workerWrite})`,
    );
  }
}

/** Empty context document for a run. */
export function emptyRunContext(runId: string, now: string = new Date().toISOString()): RunContext {
  return {
    schema_version: SCHEMA_VERSION,
    run_id: runId,
    updated_at: now,
    kv: {},
  };
}

/** Snapshot map for AgentSession.context_kv injection. */
export function contextSnapshot(ctx: RunContext | null | undefined): Record<string, unknown> {
  if (!ctx) return {};
  return { ...ctx.kv };
}

/** Sorted list of keys for deterministic CLI/API output. */
export function listContextKeys(ctx: RunContext | null | undefined): string[] {
  if (!ctx) return [];
  return Object.keys(ctx.kv).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Read one key; returns undefined when missing (not an error).
 */
export function getContextValue(
  ctx: RunContext | null | undefined,
  key: string,
): unknown {
  assertValidContextKey(key);
  if (!ctx) return undefined;
  return Object.prototype.hasOwnProperty.call(ctx.kv, key)
    ? ctx.kv[key]
    : undefined;
}

/**
 * Enforce document-level quotas on a prospective `kv` map.
 */
export function assertContextQuota(nextKv: Record<string, unknown>): void {
  const keyCount = Object.keys(nextKv).length;
  if (keyCount > CONTEXT_MAX_KEYS) {
    throw new ContextKvError(
      "quota_exceeded",
      `context exceeds max keys (${CONTEXT_MAX_KEYS})`,
    );
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(nextKv);
  } catch {
    throw new ContextKvError(
      "invalid_value",
      "context kv must be JSON-serializable",
    );
  }
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > CONTEXT_MAX_KV_BYTES) {
    throw new ContextKvError(
      "quota_exceeded",
      `context kv exceeds ${CONTEXT_MAX_KV_BYTES} bytes`,
    );
  }
}

/**
 * Pure set: returns new document with key updated.
 */
export function setContextValue(
  ctx: RunContext,
  key: string,
  value: unknown,
  now: string = new Date().toISOString(),
): RunContext {
  assertValidContextKey(key);
  assertValidContextValue(value);
  const kv = { ...ctx.kv, [key]: value };
  assertContextQuota(kv);
  return {
    ...ctx,
    schema_version: SCHEMA_VERSION,
    updated_at: now,
    kv,
  };
}

/**
 * Pure delete: returns new document with key removed.
 * Missing keys are a no-op (still bumps updated_at only if present).
 */
export function deleteContextValue(
  ctx: RunContext,
  key: string,
  now: string = new Date().toISOString(),
): { context: RunContext; deleted: boolean } {
  assertValidContextKey(key);
  if (!Object.prototype.hasOwnProperty.call(ctx.kv, key)) {
    return { context: ctx, deleted: false };
  }
  const next = { ...ctx.kv };
  delete next[key];
  return {
    context: {
      ...ctx,
      schema_version: SCHEMA_VERSION,
      updated_at: now,
      kv: next,
    },
    deleted: true,
  };
}
