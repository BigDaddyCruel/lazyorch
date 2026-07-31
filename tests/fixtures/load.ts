/**
 * Load and materialize adapter record/replay fixtures (fake mode).
 *
 * Placeholders in fixture strings:
 *   {session_dir}  absolute session directory
 *   {cwd}          session working directory (usually same as session_dir)
 *   {prompt_file}  path to prompt.md
 *   {run_handle}   basename of session_dir (adapter run handle)
 */

import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  FirstClassCodingId,
  RecordedStart,
  SessionResult,
} from "@lazyorch/adapters";
import { FIRST_CLASS_CODING_IDS } from "@lazyorch/adapters";

export const FIXTURES_ROOT = dirname(fileURLToPath(import.meta.url));
export const ADAPTER_FIXTURES_DIR = join(FIXTURES_ROOT, "adapters");

export interface AdapterFakeFixtureSession {
  model: string;
  model_tier: string | null;
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

function extractRunHandle(sessionDir: string): string {
  const parts = sessionDir.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? basename(sessionDir);
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
    adapter_id: substitutePlaceholders(raw.adapter_id, ctx),
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

function assertFixtureShape(raw: unknown, path: string): AdapterFakeFixture {
  if (raw === null || typeof raw !== "object") {
    throw new Error(`fixture ${path}: expected object`);
  }
  const f = raw as AdapterFakeFixture;
  if (f.schema_version !== 1) {
    throw new Error(`fixture ${path}: unsupported schema_version ${String(f.schema_version)}`);
  }
  if (!(FIRST_CLASS_CODING_IDS as readonly string[]).includes(f.adapter_id)) {
    throw new Error(`fixture ${path}: unknown adapter_id ${f.adapter_id}`);
  }
  if (f.mode !== "fake") {
    throw new Error(`fixture ${path}: expected mode "fake", got ${String(f.mode)}`);
  }
  if (!f.recorded_start || !f.session_result || !f.session) {
    throw new Error(`fixture ${path}: missing recorded_start, session_result, or session`);
  }
  return f;
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
  const parsed: unknown = JSON.parse(text);
  return assertFixtureShape(parsed, path);
}

/**
 * Load fixture and expand path placeholders for a concrete session dir.
 * Use when comparing argv / recorded starts from a live fake-mode start.
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
