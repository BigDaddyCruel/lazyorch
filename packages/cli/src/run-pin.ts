/**
 * Run-level model pin stored in context KV under `model_pin/run`.
 *
 * Shape matches core `ModelPin` so schedulers / `routeModel` / `models route --run`
 * can load it into `RouteInput.run_pin` without remapping.
 *
 * Design: CLI/GUI pin is priority 2 (after task pin). Consumer path:
 *   context.kv["model_pin/run"] → ModelPin → routeModel({ run_pin })
 */
import {
  isModelTier,
  type ModelPin,
  type ModelTier,
  type RunContext,
} from "@lazyorch/core";

/** Context key for the structured run pin (JSON object). */
export const RUN_PIN_CONTEXT_KEY = "model_pin/run" as const;

/**
 * Build a ModelPin from CLI start flags.
 * Returns null when no pin fields set; throws Error with message on invalid tier.
 */
export function buildRunPin(opts: {
  tier?: string;
  model?: string;
  adapter?: string;
}): ModelPin | null {
  if (!opts.tier && !opts.model && !opts.adapter) return null;
  const pin: ModelPin = {};
  if (opts.tier) {
    if (!isModelTier(opts.tier)) {
      throw new Error(
        `invalid --tier '${opts.tier}' (expected nano|small|medium|large|xlarge)`,
      );
    }
    pin.tier_override = opts.tier as ModelTier;
  }
  if (opts.model) pin.model_override = opts.model;
  if (opts.adapter) pin.adapter_override = opts.adapter;
  return pin;
}

/**
 * Parse ModelPin from a context document (or raw kv value).
 * Accepts the structured object written by `start`, or legacy scalar keys.
 */
export function runPinFromContext(
  ctx: Pick<RunContext, "kv"> | Record<string, unknown> | null | undefined,
): ModelPin | undefined {
  if (!ctx) return undefined;
  const kv =
    "kv" in ctx && typeof ctx.kv === "object" && ctx.kv !== null
      ? (ctx.kv as Record<string, unknown>)
      : (ctx as Record<string, unknown>);

  const structured = kv[RUN_PIN_CONTEXT_KEY];
  if (structured && typeof structured === "object" && !Array.isArray(structured)) {
    const obj = structured as Record<string, unknown>;
    const pin: ModelPin = {};
    if (isModelTier(obj.tier_override)) {
      pin.tier_override = obj.tier_override;
    }
    if (typeof obj.model_override === "string" && obj.model_override.length > 0) {
      pin.model_override = obj.model_override;
    }
    if (
      typeof obj.adapter_override === "string" &&
      obj.adapter_override.length > 0
    ) {
      pin.adapter_override = obj.adapter_override;
    }
    if (
      pin.tier_override !== undefined ||
      pin.model_override !== undefined ||
      pin.adapter_override !== undefined
    ) {
      return pin;
    }
  }

  // Legacy scalar keys (pre-fix) — still map if present
  const pin: ModelPin = {};
  if (isModelTier(kv["model_pin/run_tier"])) {
    pin.tier_override = kv["model_pin/run_tier"] as ModelTier;
  }
  if (typeof kv["model_pin/run_model"] === "string") {
    pin.model_override = kv["model_pin/run_model"];
  }
  if (typeof kv["model_pin/run_adapter"] === "string") {
    pin.adapter_override = kv["model_pin/run_adapter"];
  }
  if (
    pin.tier_override !== undefined ||
    pin.model_override !== undefined ||
    pin.adapter_override !== undefined
  ) {
    return pin;
  }
  return undefined;
}
