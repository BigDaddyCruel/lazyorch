import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  LazyorchConfigSchema,
  type LazyorchConfig,
  type LazyorchConfigInput,
} from "./schema.js";
import {
  validateSlotPacking,
  type SlotPackingResult,
} from "./packing.js";

export class ConfigValidationError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

export interface ParseConfigResult {
  config: LazyorchConfig;
  packing: SlotPackingResult;
  warnings: string[];
}

export interface ParseConfigOptions {
  /**
   * When true (e.g. CI / headless), apply KD-44 effective default:
   * if timeout_action was not explicitly set, use `fail`.
   */
  ci?: boolean;
  /**
   * When true (default), fail hard on slot packing min-team invariant.
   * Schema-level errors always fail.
   */
  enforcePacking?: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolve features.model_routing ↔ models.routing_enabled alias (KD).
 * If either is false → routing off.
 *
 * Does not invent objects for non-object values — invalid types are left
 * for Zod to reject.
 */
function applyRoutingAlias(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const modelsPresent = "models" in raw;
  const featuresPresent = "features" in raw;
  const modelsIsObj = isPlainObject(raw.models);
  const featuresIsObj = isPlainObject(raw.features);

  // If either section is present but not a plain object, leave untouched.
  if (
    (modelsPresent && !modelsIsObj) ||
    (featuresPresent && !featuresIsObj)
  ) {
    return raw;
  }

  const models: Record<string, unknown> = modelsIsObj
    ? { ...(raw.models as Record<string, unknown>) }
    : {};
  const features: Record<string, unknown> = featuresIsObj
    ? { ...(raw.features as Record<string, unknown>) }
    : {};

  const modelsRouting =
    typeof models.routing_enabled === "boolean"
      ? models.routing_enabled
      : undefined;
  const featuresRouting =
    typeof features.model_routing === "boolean"
      ? features.model_routing
      : undefined;

  let resolved = true;
  if (modelsRouting === false || featuresRouting === false) {
    resolved = false;
  } else if (modelsRouting === true || featuresRouting === true) {
    resolved = true;
  }

  models.routing_enabled = resolved;
  features.model_routing = resolved;

  return { ...raw, models, features };
}

/**
 * Apply CI/headless gate timeout default (KD-44) when not explicitly set.
 * Leaves non-object `gates` untouched so Zod can reject it.
 */
function applyCiTimeoutDefault(
  raw: Record<string, unknown>,
  ci: boolean,
): Record<string, unknown> {
  if (!ci) return raw;
  if ("gates" in raw && !isPlainObject(raw.gates)) {
    return raw;
  }
  const gates = isPlainObject(raw.gates) ? { ...raw.gates } : {};
  if (gates.timeout_action === undefined) {
    gates.timeout_action = "fail";
    return { ...raw, gates };
  }
  return raw;
}

/**
 * Solo mode (design / KD-25): 1 lead implements; 0 workers/reviewers/QA;
 * force compensating gates (task_approve, plan_approve, merge).
 */
function applySoloMode(config: LazyorchConfig): LazyorchConfig {
  if (config.team.mode !== "solo") return config;
  return {
    ...config,
    team: {
      ...config.team,
      min_reviewers: 0,
      max_reviewers: 0,
      min_qa: 0,
      max_qa: 0,
    },
    elasticity: {
      ...config.elasticity,
      min_workers: 0,
      max_workers: 0,
    },
    gates: {
      ...config.gates,
      task_approve: true,
      plan_approve: true,
      merge: true,
    },
  };
}

function formatZodIssues(
  error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> },
): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
}

function packingFromConfig(config: LazyorchConfig): SlotPackingResult {
  return validateSlotPacking({
    max_concurrent_agents: config.scheduling.max_concurrent_agents,
    max_workers: config.elasticity.max_workers,
    reserve_slots_lead: config.reserve_slots.lead,
    min_reviewers: config.team.min_reviewers,
    min_qa: config.team.min_qa,
    max_reviewers: config.team.max_reviewers,
    max_qa: config.team.max_qa,
  });
}

/**
 * Parse and validate a plain config object (already YAML/JSON decoded).
 * Throws ConfigValidationError on schema or (optional) packing failures.
 */
export function parseConfig(
  input: unknown,
  options: ParseConfigOptions = {},
): ParseConfigResult {
  const { ci = false, enforcePacking = true } = options;

  if (input === null || input === undefined) {
    throw new ConfigValidationError("config is empty", ["(root): config is empty"]);
  }
  if (!isPlainObject(input)) {
    throw new ConfigValidationError("config must be a mapping/object", [
      "(root): expected object",
    ]);
  }

  let raw = applyRoutingAlias(input);
  raw = applyCiTimeoutDefault(raw, ci);

  const parsed = LazyorchConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = formatZodIssues(parsed.error);
    throw new ConfigValidationError(
      `invalid config: ${issues.join("; ")}`,
      issues,
    );
  }

  const config = applySoloMode(parsed.data);
  const packing = packingFromConfig(config);
  const warnings = [...packing.warnings];

  if (enforcePacking && !packing.ok) {
    throw new ConfigValidationError(
      `slot packing failed: ${packing.errors.join("; ")}`,
      packing.errors,
    );
  }

  return { config, packing, warnings };
}

/**
 * Parse YAML text into a validated LazyOrch config.
 */
export function parseConfigYaml(
  yamlText: string,
  options: ParseConfigOptions = {},
): ParseConfigResult {
  let decoded: unknown;
  try {
    decoded = parseYaml(yamlText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConfigValidationError(`YAML parse error: ${msg}`, [
      `(yaml): ${msg}`,
    ]);
  }
  return parseConfig(decoded, options);
}

/**
 * Build a fully defaulted config (design defaults).
 * @param overrides partial deep overrides applied before schema parse
 * @param options parse options (ci, enforcePacking)
 */
export function defaultConfig(
  overrides: LazyorchConfigInput = {},
  options: ParseConfigOptions = {},
): LazyorchConfig {
  return parseConfig(overrides, options).config;
}

/**
 * Serialize a config object to YAML (operator-facing).
 */
export function stringifyConfigYaml(config: LazyorchConfig): string {
  return stringifyYaml(config, {
    indent: 2,
    lineWidth: 100,
    defaultStringType: "PLAIN",
    defaultKeyType: "PLAIN",
  });
}

/** Extract packing inputs from a validated config (for tests / doctor). */
export function slotPackingForConfig(config: LazyorchConfig): SlotPackingResult {
  return packingFromConfig(config);
}
