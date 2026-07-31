/**
 * `lazyorch models route` — dry-run complexity router (no session start).
 */
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import {
  dryRunRoute,
  type ComplexitySignals,
  type DryRunRouteResult,
  type ModelPin,
  type PartialDeepModelsConfig,
} from "@lazyorch/core";
import { parseConfigYaml } from "@lazyorch/shared";
import { EXIT } from "../exit-codes.js";
import { writeJson } from "../util.js";

export type ModelsSubcommand = "route";

export interface ModelsCommandOptions {
  action: ModelsSubcommand;
  /** Role for routing (default worker). */
  role?: string;
  /** Optional task id for event payload. */
  task?: string;
  /** Optional JSON signals object. */
  signalsJson?: string;
  /** Pin overrides. */
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

/**
 * Run `lazyorch models route --role <role> | --task <id>`.
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

  let runPin: ModelPin | undefined;
  if (options.tier || options.model || options.adapter) {
    runPin = {};
    if (options.tier) {
      runPin.tier_override = options.tier as NonNullable<
        ModelPin["tier_override"]
      >;
    }
    if (options.model) runPin.model_override = options.model;
    if (options.adapter) runPin.adapter_override = options.adapter;
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
        message: result.error,
      };
    }

    return { exitCode: EXIT.OK, action: "route", result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Adapter selection failures → exit 4
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
