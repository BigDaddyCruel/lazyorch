/**
 * `lazyorch start "<idea>"` — create a run under local StateStore.
 *
 * Full orchestration is daemon-owned; this creates the durable run entity
 * (Inception) so operators / later ticks can proceed.
 *
 * Pins (`--tier|--model|--adapter`) are stored as structured `ModelPin` under
 * context key `model_pin/run` for `routeModel({ run_pin })` consumers
 * (see `runPinFromContext` / `models route --run`).
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  SCHEMA_VERSION,
  generateId,
  type Run,
} from "@lazyorch/core";
import { EXIT } from "../exit-codes.js";
import {
  RUN_PIN_CONTEXT_KEY,
  buildRunPin,
} from "../run-pin.js";
import {
  createStore,
  listAllGates,
  stateRoot,
  writeJson,
  writeLine,
} from "../util.js";

export interface StartOptions {
  /** Idea text (positional). */
  idea?: string;
  /** Read idea from file (-f). */
  ideaFile?: string;
  /** Soft budget USD hint stored on run context (not enforced here). */
  budgetUsd?: number;
  /**
   * Reserved: design allowlist auto-skip is not implemented.
   * Passing --yes is rejected (exit 2) so operators are not misled.
   */
  yes?: boolean;
  /** Pin tier / model / adapter → context `model_pin/run` (ModelPin). */
  tier?: string;
  model?: string;
  adapter?: string;
  repo?: string;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  pretty?: boolean;
  /** Inject clock for tests. */
  now?: () => string;
  /** Inject id generator for tests. */
  nextId?: () => string;
}

export interface StartResult {
  exitCode: number;
  run?: Run;
  message?: string;
  pendingGates?: number;
  runPin?: ReturnType<typeof buildRunPin>;
}

async function loadProjectId(repo: string): Promise<string | null> {
  try {
    const raw = await readFile(resolve(repo, ".lazyorch", "project.json"), "utf8");
    const proj = JSON.parse(raw) as { id?: unknown };
    return typeof proj.id === "string" && proj.id.length > 0 ? proj.id : null;
  } catch {
    return null;
  }
}

async function readIdeaFile(path: string): Promise<string> {
  return (await readFile(path, "utf8")).trim();
}

/**
 * Create a new run from an idea.
 */
export async function runStart(options: StartOptions = {}): Promise<StartResult> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const pretty = options.pretty !== false;
  const repo = resolve(options.repo ?? process.cwd());

  if (options.yes === true) {
    stderr.write(
      "error: --yes is not implemented (gate allowlist auto-skip deferred); omit the flag\n",
    );
    return { exitCode: EXIT.USAGE, message: "yes_not_implemented" };
  }

  let idea = options.idea?.trim() ?? "";
  if (options.ideaFile) {
    try {
      idea = await readIdeaFile(resolve(options.ideaFile));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stderr.write(`error: cannot read idea file: ${msg}\n`);
      return { exitCode: EXIT.ERROR, message: "idea_file" };
    }
  }
  if (!idea) {
    stderr.write('error: start requires an idea string or -f <file>\n');
    return { exitCode: EXIT.USAGE, message: "missing idea" };
  }

  const projectId = await loadProjectId(repo);
  if (!projectId) {
    stderr.write(
      `error: project not initialized (missing ${stateRoot(repo)}/project.json); run lazyorch init\n`,
    );
    return { exitCode: EXIT.ERROR, message: "no_project" };
  }

  let runPin: ReturnType<typeof buildRunPin> = null;
  try {
    runPin = buildRunPin({
      ...(options.tier !== undefined ? { tier: options.tier } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.adapter !== undefined ? { adapter: options.adapter } : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(`error: ${msg}\n`);
    return { exitCode: EXIT.USAGE, message: msg };
  }

  const store = createStore(repo);
  // Pending gates on other runs do not block start; only report.
  const pending = await listAllGates(store, { status: "pending" });

  const ts = options.now?.() ?? new Date().toISOString();
  const id = options.nextId?.() ?? generateId("run");
  const run: Run = {
    schema_version: SCHEMA_VERSION,
    id,
    project_id: projectId,
    phase: "Inception",
    idea,
    created_at: ts,
    updated_at: ts,
  };

  await store.writeRun(run);
  await store.writeGates(run.id, []);

  if (options.budgetUsd !== undefined) {
    await store.setContextKey(run.id, "budget_usd", options.budgetUsd);
  }
  if (runPin) {
    // Structured ModelPin for routeModel({ run_pin: … })
    await store.setContextKey(run.id, RUN_PIN_CONTEXT_KEY, runPin);
  }

  writeJson(
    stdout,
    {
      ok: true,
      run_id: run.id,
      project_id: run.project_id,
      phase: run.phase,
      idea: run.idea,
      pending_gates_elsewhere: pending.length,
      run_pin: runPin,
    },
    pretty,
  );

  if (pending.length > 0) {
    writeLine(
      stderr,
      `note: ${pending.length} pending gate(s) in this project (see lazyorch gate list)`,
    );
  }

  return {
    exitCode: EXIT.OK,
    run,
    pendingGates: pending.length,
    ...(runPin ? { runPin } : {}),
  };
}
