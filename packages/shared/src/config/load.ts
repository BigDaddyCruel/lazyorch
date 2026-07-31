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
 */
function applyRoutingAlias(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const models = isPlainObject(raw.models) ? { ...raw.models } : {};
  const features = isPlainObject(raw.features) ? { ...raw.features } : {};

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
 */
function applyCiTimeoutDefault(
  raw: Record<string, unknown>,
  ci: boolean,
): Record<string, unknown> {
  if (!ci) return raw;
  const gates = isPlainObject(raw.gates) ? { ...raw.gates } : {};
  if (gates.timeout_action === undefined) {
    gates.timeout_action = "fail";
    return { ...raw, gates };
  }
  return raw;
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

  const config = parsed.data;
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
