/**
 * `lazyorch models route` — dry-run complexity router (no session start).
 *
 * Pin sources (priority): CLI flags > context `model_pin/run` when `--run` set.
 */
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import {
  dryRunRoute,
  isModelTier,
  type ComplexitySignals,
  type DryRunRouteResult,
  type ModelPin,
  type ModelTier,
  type PartialDeepModelsConfig,
} from "@lazyorch/core";
import { parseConfigYaml } from "@lazyorch/shared";
import { EXIT } from "../exit-codes.js";
import { runPinFromContext } from "../run-pin.js";
import { createStore, writeJson } from "../util.js";

export type ModelsSubcommand = "route";

export interface ModelsCommandOptions {
  action: ModelsSubcommand;
  /** Role for routing (default worker). */
  role?: string;
  /** Optional task id for event payload. */
  task?: string;
  /**
   * Load run_pin from context `model_pin/run` for this run
   * (written by `lazyorch start --tier|--model|--adapter`).
   */
  run?: string;
  /** Optional JSON signals object. */
  signalsJson?: string;
  /** Pin overrides (override context pin when both set). */
  tier?: string;
  model?: string;
  adapter?: string;
  budgetPressure?: boolean;
  preferredAdapters?: string[];
  repo?: string;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  pretty?: boolean;
  /** Inject dry-run for tests. */
  dryRun?: typeof dryRunRoute;
  /** Inject config load for tests. */
  loadConfig?: (repo: string) => Promise<PartialDeepModelsConfig | undefined>;
}

export interface ModelsCommandResult {
  exitCode: number;
  action: ModelsSubcommand;
  result?: DryRunRouteResult;
  runPin?: ModelPin;
  message?: string;
}

async function defaultLoadConfig(
  repo: string,
): Promise<PartialDeepModelsConfig | undefined> {
  try {
    const raw = await readFile(
      resolve(repo, ".lazyorch", "config.yml"),
      "utf8",
    );
    const { config } = parseConfigYaml(raw);
    return config.models as unknown as PartialDeepModelsConfig | undefined;
  } catch {
    return undefined;
  }
}

function pinFromFlags(opts: {
  tier?: string;
  model?: string;
  adapter?: string;
}): { ok: true; pin?: ModelPin } | { ok: false; message: string } {
  if (!opts.tier && !opts.model && !opts.adapter) {
    return { ok: true };
  }
  const pin: ModelPin = {};
  if (opts.tier) {
    if (!isModelTier(opts.tier)) {
      return {
        ok: false,
        message: `invalid --tier '${opts.tier}' (expected nano|small|medium|large|xlarge)`,
      };
    }
    pin.tier_override = opts.tier as ModelTier;
  }
  if (opts.model) pin.model_override = opts.model;
  if (opts.adapter) pin.adapter_override = opts.adapter;
  return { ok: true, pin };
}

/**
 * Run `lazyorch models route --role <role> | --task <id> | --run <id>`.
 */
export async function runModels(
  options: ModelsCommandOptions,
): Promise<ModelsCommandResult> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const pretty = options.pretty !== false;
  const repo = resolve(options.repo ?? process.cwd());

  if (options.action !== "route") {
    stderr.write("error: models requires route\n");
    return { exitCode: EXIT.USAGE, action: options.action, message: "usage" };
  }

  const role = options.role?.trim() || "worker";
  let signals: Partial<ComplexitySignals> | undefined;
  if (options.signalsJson) {
    try {
      signals = JSON.parse(options.signalsJson) as Partial<ComplexitySignals>;
    } catch {
      stderr.write("error: --signals must be valid JSON\n");
      return { exitCode: EXIT.USAGE, action: "route", message: "bad signals" };
    }
  }

  const flags = pinFromFlags({
    ...(options.tier !== undefined ? { tier: options.tier } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.adapter !== undefined ? { adapter: options.adapter } : {}),
  });
  if (!flags.ok) {
    stderr.write(`error: ${flags.message}\n`);
    return { exitCode: EXIT.USAGE, action: "route", message: flags.message };
  }

  // Context pin from start (when --run provided)
  let contextPin: ModelPin | undefined;
  if (options.run) {
    const store = createStore(repo);
    const run = await store.readRun(options.run);
    if (!run) {
      stderr.write(`error: run not found: ${options.run}\n`);
      return {
        exitCode: EXIT.ERROR,
        action: "route",
        message: "run_not_found",
      };
    }
    const ctx = await store.loadOrEmptyContext(options.run);
    contextPin = runPinFromContext(ctx);
  }

  // CLI flags override context pin field-wise
  let runPin: ModelPin | undefined = contextPin;
  if (flags.pin) {
    runPin = { ...(contextPin ?? {}), ...flags.pin };
  }

  const loadConfig = options.loadConfig ?? defaultLoadConfig;
  const config = await loadConfig(repo);
  const routeFn = options.dryRun ?? dryRunRoute;

  try {
    const result = routeFn({
      role,
      ...(options.task ? { task_id: options.task } : {}),
      ...(signals ? { signals } : {}),
      ...(runPin ? { run_pin: runPin } : {}),
      ...(options.budgetPressure !== undefined
        ? { budget_pressure: options.budgetPressure }
        : {}),
      ...(options.preferredAdapters
        ? { preferred_adapters: options.preferredAdapters }
        : {}),
      ...(config ? { config } : {}),
    });

    writeJson(
      stdout,
      {
        dry_run: true,
        role,
        task_id: options.task ?? null,
        run_id: options.run ?? null,
        run_pin: runPin ?? null,
        tier: result.tier,
        adapter_id: result.adapter_id,
        model: result.model,
        reason: result.reason,
        score: result.score ?? null,
        effort: result.effort ?? null,
        error: result.error ?? null,
        event: result.event,
      },
      pretty,
    );

    if (result.error && /adapter|no.*available|missing/i.test(result.error)) {
      return {
        exitCode: EXIT.ADAPTER_MISSING,
        action: "route",
        result,
        ...(runPin ? { runPin } : {}),
        message: result.error,
      };
    }

    return {
      exitCode: EXIT.OK,
      action: "route",
      result,
      ...(runPin ? { runPin } : {}),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/adapter|no.*available|missing.*binary/i.test(msg)) {
      stderr.write(`error: ${msg}\n`);
      return {
        exitCode: EXIT.ADAPTER_MISSING,
        action: "route",
        message: msg,
      };
    }
    stderr.write(`error: ${msg}\n`);
    return { exitCode: EXIT.ERROR, action: "route", message: msg };
  }
}
