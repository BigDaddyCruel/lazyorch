/**
 * Load and materialize adapter fake-mode fixtures (golden argv + canned results).
 *
 * These are **hand-authored** samples for CI without live LLMs — not live
 * `LAZYORCH_ADAPTER_MODE=record` captures. Argv shapes match first-class
 * profiles under default test registration binaries (`/bin/<id>`), not PATH
 * discovery on a real Windows install.
 *
 * Placeholders in fixture strings:
 *   {session_dir}  absolute session directory
 *   {cwd}          session working directory (usually same as session_dir)
 *   {prompt_file}  path to prompt.md
 *   {run_handle}   last path segment of session_dir (see extractRunHandle)
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FIRST_CLASS_CODING_IDS,
  extractRunHandle,
  type FirstClassCodingId,
  type RecordedStart,
  type SessionResult,
} from "@lazyorch/adapters";
import { MODEL_TIERS, type ModelTier } from "@lazyorch/shared";

export const FIXTURES_ROOT = dirname(fileURLToPath(import.meta.url));
export const ADAPTER_FIXTURES_DIR = join(FIXTURES_ROOT, "adapters");

const SESSION_STATUSES = [
  "ok",
  "error",
  "cancelled",
  "timeout",
  "stall",
] as const;

const SESSION_KINDS = ["llm", "deterministic"] as const;

export interface AdapterFakeFixtureSession {
  model: string;
  model_tier: ModelTier | null;
  role: string;
  session_kind: "llm" | "deterministic";
}

export interface AdapterFakeFixture {
  schema_version: number;
  adapter_id: FirstClassCodingId;
  mode: "fake";
  description?: string;
  session: AdapterFakeFixtureSession;
  recorded_start: RecordedStart;
  session_result: SessionResult;
}

export interface FixturePathContext {
  session_dir: string;
  cwd?: string;
  prompt_file?: string;
  run_handle?: string;
}

export class FixtureLoadError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`fixture ${path}: ${message}`);
    this.name = "FixtureLoadError";
    this.path = path;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isModelTier(value: unknown): value is ModelTier {
  return (
    typeof value === "string" &&
    (MODEL_TIERS as readonly string[]).includes(value)
  );
}

function parseSession(
  raw: unknown,
  path: string,
): AdapterFakeFixtureSession {
  if (!isObject(raw)) {
    throw new FixtureLoadError(path, "session must be an object");
  }
  if (!isNonEmptyString(raw.model)) {
    throw new FixtureLoadError(path, "session.model must be a non-empty string");
  }
  if (raw.model_tier !== null && !isModelTier(raw.model_tier)) {
    throw new FixtureLoadError(
      path,
      `session.model_tier must be null or one of ${MODEL_TIERS.join(", ")}`,
    );
  }
  if (!isNonEmptyString(raw.role)) {
    throw new FixtureLoadError(path, "session.role must be a non-empty string");
  }
  if (
    typeof raw.session_kind !== "string" ||
    !(SESSION_KINDS as readonly string[]).includes(raw.session_kind)
  ) {
    throw new FixtureLoadError(
      path,
      `session.session_kind must be one of ${SESSION_KINDS.join(", ")}`,
    );
  }
  return {
    model: raw.model,
    model_tier: raw.model_tier as ModelTier | null,
    role: raw.role,
    session_kind: raw.session_kind as "llm" | "deterministic",
  };
}

function parseRecordedStart(raw: unknown, path: string): RecordedStart {
  if (!isObject(raw)) {
    throw new FixtureLoadError(path, "recorded_start must be an object");
  }
  if (!isNonEmptyString(raw.adapter_id)) {
    throw new FixtureLoadError(path, "recorded_start.adapter_id required");
  }
  if (!isNonEmptyString(raw.run_handle)) {
    throw new FixtureLoadError(path, "recorded_start.run_handle required");
  }
  if (!isStringArray(raw.argv) || raw.argv.length === 0) {
    throw new FixtureLoadError(
      path,
      "recorded_start.argv must be a non-empty string[]",
    );
  }
  if (!isNonEmptyString(raw.cwd)) {
    throw new FixtureLoadError(path, "recorded_start.cwd required");
  }
  if (typeof raw.model !== "string") {
    throw new FixtureLoadError(path, "recorded_start.model must be a string");
  }
  if (!isNonEmptyString(raw.session_dir)) {
    throw new FixtureLoadError(path, "recorded_start.session_dir required");
  }
  if (!isNonEmptyString(raw.started_at)) {
    throw new FixtureLoadError(path, "recorded_start.started_at required");
  }
  if (raw.mode !== "fake" && raw.mode !== "record" && raw.mode !== "live") {
    throw new FixtureLoadError(
      path,
      `recorded_start.mode must be live|fake|record, got ${String(raw.mode)}`,
    );
  }
  const out: RecordedStart = {
    adapter_id: raw.adapter_id,
    run_handle: raw.run_handle,
    argv: raw.argv,
    cwd: raw.cwd,
    model: raw.model,
    session_dir: raw.session_dir,
    started_at: raw.started_at,
    mode: raw.mode,
  };
  if (raw.prompt_file !== undefined) {
    if (!isNonEmptyString(raw.prompt_file)) {
      throw new FixtureLoadError(
        path,
        "recorded_start.prompt_file must be a non-empty string when set",
      );
    }
    out.prompt_file = raw.prompt_file;
  }
  return out;
}

function parseSessionResult(raw: unknown, path: string): SessionResult {
  if (!isObject(raw)) {
    throw new FixtureLoadError(path, "session_result must be an object");
  }
  if (
    typeof raw.status !== "string" ||
    !(SESSION_STATUSES as readonly string[]).includes(raw.status)
  ) {
    throw new FixtureLoadError(
      path,
      `session_result.status must be one of ${SESSION_STATUSES.join(", ")}`,
    );
  }
  const result: SessionResult = {
    status: raw.status as SessionResult["status"],
  };
  if (raw.exit_code !== undefined) {
    if (typeof raw.exit_code !== "number") {
      throw new FixtureLoadError(path, "session_result.exit_code must be a number");
    }
    result.exit_code = raw.exit_code;
  }
  if (raw.adapter_id !== undefined) {
    if (!isNonEmptyString(raw.adapter_id)) {
      throw new FixtureLoadError(path, "session_result.adapter_id must be a string");
    }
    result.adapter_id = raw.adapter_id;
  }
  if (raw.model_used !== undefined) {
    if (typeof raw.model_used !== "string") {
      throw new FixtureLoadError(path, "session_result.model_used must be a string");
    }
    result.model_used = raw.model_used;
  }
  if (raw.summary !== undefined) {
    if (typeof raw.summary !== "string") {
      throw new FixtureLoadError(path, "session_result.summary must be a string");
    }
    result.summary = raw.summary;
  }
  if (raw.usage !== undefined) {
    if (!isObject(raw.usage)) {
      throw new FixtureLoadError(path, "session_result.usage must be an object");
    }
    const usage: NonNullable<SessionResult["usage"]> = {};
    if (raw.usage.input_tokens !== undefined) {
      if (typeof raw.usage.input_tokens !== "number") {
        throw new FixtureLoadError(path, "usage.input_tokens must be a number");
      }
      usage.input_tokens = raw.usage.input_tokens;
    }
    if (raw.usage.output_tokens !== undefined) {
      if (typeof raw.usage.output_tokens !== "number") {
        throw new FixtureLoadError(path, "usage.output_tokens must be a number");
      }
      usage.output_tokens = raw.usage.output_tokens;
    }
    if (raw.usage.estimated_usd !== undefined) {
      if (typeof raw.usage.estimated_usd !== "number") {
        throw new FixtureLoadError(path, "usage.estimated_usd must be a number");
      }
      usage.estimated_usd = raw.usage.estimated_usd;
    }
    result.usage = usage;
  }
  return result;
}

/**
 * Validate and coerce fixture JSON. When `expectedAdapterId` is set (load by
 * filename id), require `adapter_id` to match.
 */
export function assertFixtureShape(
  raw: unknown,
  path: string,
  expectedAdapterId?: FirstClassCodingId,
): AdapterFakeFixture {
  if (!isObject(raw)) {
    throw new FixtureLoadError(path, "expected object");
  }
  if (raw.schema_version !== 1) {
    throw new FixtureLoadError(
      path,
      `unsupported schema_version ${String(raw.schema_version)}`,
    );
  }
  if (
    typeof raw.adapter_id !== "string" ||
    !(FIRST_CLASS_CODING_IDS as readonly string[]).includes(raw.adapter_id)
  ) {
    throw new FixtureLoadError(
      path,
      `unknown adapter_id ${String(raw.adapter_id)}`,
    );
  }
  const adapter_id = raw.adapter_id as FirstClassCodingId;
  if (expectedAdapterId !== undefined && adapter_id !== expectedAdapterId) {
    throw new FixtureLoadError(
      path,
      `adapter_id "${adapter_id}" does not match expected "${expectedAdapterId}"`,
    );
  }
  if (raw.mode !== "fake") {
    throw new FixtureLoadError(
      path,
      `expected mode "fake", got ${String(raw.mode)}`,
    );
  }

  const session = parseSession(raw.session, path);
  const recorded_start = parseRecordedStart(raw.recorded_start, path);
  const session_result = parseSessionResult(raw.session_result, path);

  if (recorded_start.adapter_id !== adapter_id) {
    throw new FixtureLoadError(
      path,
      `recorded_start.adapter_id "${recorded_start.adapter_id}" !== fixture adapter_id "${adapter_id}"`,
    );
  }
  if (
    session_result.adapter_id !== undefined &&
    session_result.adapter_id !== adapter_id
  ) {
    throw new FixtureLoadError(
      path,
      `session_result.adapter_id "${session_result.adapter_id}" !== fixture adapter_id "${adapter_id}"`,
    );
  }

  const fixture: AdapterFakeFixture = {
    schema_version: 1,
    adapter_id,
    mode: "fake",
    session,
    recorded_start,
    session_result,
  };
  if (typeof raw.description === "string") {
    fixture.description = raw.description;
  }
  return fixture;
}

function substitutePlaceholders(
  value: string,
  ctx: Required<FixturePathContext>,
): string {
  return value
    .replaceAll("{session_dir}", ctx.session_dir)
    .replaceAll("{cwd}", ctx.cwd)
    .replaceAll("{prompt_file}", ctx.prompt_file)
    .replaceAll("{run_handle}", ctx.run_handle);
}

function materializeRecordedStart(
  raw: RecordedStart,
  ctx: Required<FixturePathContext>,
): RecordedStart {
  return {
    adapter_id: raw.adapter_id,
    run_handle: substitutePlaceholders(raw.run_handle, ctx),
    argv: raw.argv.map((t) => substitutePlaceholders(t, ctx)),
    cwd: substitutePlaceholders(raw.cwd, ctx),
    model: raw.model,
    session_dir: substitutePlaceholders(raw.session_dir, ctx),
    started_at: raw.started_at,
    mode: raw.mode,
    ...(raw.prompt_file !== undefined
      ? { prompt_file: substitutePlaceholders(raw.prompt_file, ctx) }
      : {}),
  };
}

/** Absolute path to `tests/fixtures/adapters/<id>.fake.json`. */
export function adapterFixturePath(adapterId: FirstClassCodingId): string {
  return join(ADAPTER_FIXTURES_DIR, `${adapterId}.fake.json`);
}

/** Load raw fixture JSON (placeholders not expanded). */
export async function loadAdapterFakeFixture(
  adapterId: FirstClassCodingId,
): Promise<AdapterFakeFixture> {
  const path = adapterFixturePath(adapterId);
  const text = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new FixtureLoadError(path, `invalid JSON: ${msg}`);
  }
  return assertFixtureShape(parsed, path, adapterId);
}

/**
 * Load fixture and expand path placeholders for a concrete session dir.
 * Uses production {@link extractRunHandle} for `{run_handle}` when omitted.
 */
export async function loadMaterializedAdapterFixture(
  adapterId: FirstClassCodingId,
  paths: FixturePathContext,
): Promise<AdapterFakeFixture> {
  const fixture = await loadAdapterFakeFixture(adapterId);
  const session_dir = paths.session_dir;
  const cwd = paths.cwd ?? session_dir;
  const prompt_file = paths.prompt_file ?? join(session_dir, "prompt.md");
  const run_handle = paths.run_handle ?? extractRunHandle(session_dir);
  const ctx = { session_dir, cwd, prompt_file, run_handle };

  return {
    ...fixture,
    recorded_start: materializeRecordedStart(fixture.recorded_start, ctx),
  };
}

/** All first-class coding adapter ids that have fixture samples. */
export function expectedAdapterFixtureIds(): readonly FirstClassCodingId[] {
  return FIRST_CLASS_CODING_IDS;
}

/** Re-export production handle extraction for tests / fixtures. */
export { extractRunHandle };
