/**
 * Model complexity router — KD-42 override order + pin_locked semantics.
 *
 * Order (highest → lowest):
 *   task pin > run pin > lead pin > role floor/ceiling > estimate > budget/step-down
 *
 * pin_locked (any tier/model pin from task/run/lead) skips floor, ceiling, budget.
 * Escalate replaces step 3 only, then full 4a–9 (pins still apply).
 * Shell is deterministic path only — never coding fallback.
 */

import type { ModelTier } from "../types/model-tier.js";
import { mergeModelsConfig } from "./config.js";
import {
  DEFAULT_ADAPTERS_DEFAULT,
  DEFAULT_PREFERENCE_ORDER,
  defaultAdaptersForRouting,
} from "./defaults.js";
import { estimateComplexity, normalizeSignals } from "./estimator.js";
import { inferTierForModel, pickAdapter } from "./pick-adapter.js";
import {
  mapTierToEffort,
  maxTier,
  minTier,
  nextTier,
  tierIndex,
} from "./tiers.js";
import type {
  AdapterRouteInfo,
  ComplexitySignals,
  ModelPin,
  ModelsRoutingConfig,
  RouteInput,
  RouteReason,
  RouteResult,
} from "./types.js";

function isShellOverride(pin?: ModelPin): boolean {
  return pin?.adapter_override === "shell";
}

/**
 * Deterministic when session_kind is deterministic, or any pin sets
 * adapter_override to shell.
 */
export function isDeterministicPath(input: RouteInput): boolean {
  if (input.session_kind === "deterministic") return true;
  if (isShellOverride(input.task_pin)) return true;
  if (isShellOverride(input.run_pin)) return true;
  if (isShellOverride(input.lead_pin)) return true;
  return false;
}

/**
 * Resolve pins in priority order (task > run > lead).
 * First non-undefined field per key wins.
 * pin_locked only when tier_override or model_override is set (not adapter alone).
 */
export function resolvePins(input: RouteInput): {
  tier_override?: ModelTier;
  model_override?: string;
  adapter_override?: string;
  pin_locked: boolean;
} {
  const sources: (ModelPin | undefined)[] = [
    input.task_pin,
    input.run_pin,
    input.lead_pin,
  ];

  let tier_override: ModelTier | undefined;
  let model_override: string | undefined;
  let adapter_override: string | undefined;

  for (const pin of sources) {
    if (!pin) continue;
    if (model_override === undefined && pin.model_override !== undefined) {
      model_override = pin.model_override;
    }
    if (tier_override === undefined && pin.tier_override !== undefined) {
      tier_override = pin.tier_override;
    }
    if (adapter_override === undefined && pin.adapter_override !== undefined) {
      adapter_override = pin.adapter_override;
    }
  }

  const pin_locked =
    tier_override !== undefined || model_override !== undefined;

  const out: {
    tier_override?: ModelTier;
    model_override?: string;
    adapter_override?: string;
    pin_locked: boolean;
  } = { pin_locked };
  if (tier_override !== undefined) out.tier_override = tier_override;
  if (model_override !== undefined) out.model_override = model_override;
  if (adapter_override !== undefined) out.adapter_override = adapter_override;
  return out;
}

/** Build pickAdapter args without assigning undefined to optional props. */
function pickArgs(
  tier: ModelTier,
  pins: {
    model_override?: string | undefined;
    adapter_override?: string | undefined;
  },
  opts: {
    preferred_adapters?: string[] | undefined;
    adapters: AdapterRouteInfo[];
    adapters_default: string;
    preference_order: string[];
    pin_locked: boolean;
  },
): Parameters<typeof pickAdapter>[0] {
  const args: Parameters<typeof pickAdapter>[0] = {
    tier,
    adapters: opts.adapters,
    adapters_default: opts.adapters_default,
    preference_order: opts.preference_order,
    pin_locked: opts.pin_locked,
  };
  if (pins.model_override !== undefined) {
    args.model_override = pins.model_override;
  }
  if (pins.adapter_override !== undefined) {
    args.adapter_override = pins.adapter_override;
  }
  if (opts.preferred_adapters !== undefined) {
    args.preferred_adapters = opts.preferred_adapters;
  }
  return args;
}

function roleFloor(
  role: string,
  config: ModelsRoutingConfig,
): ModelTier {
  return config.role_tier_floor[role] ?? "nano";
}

function roleCeiling(
  role: string,
  config: ModelsRoutingConfig,
): ModelTier | undefined {
  return config.role_tier_ceiling[role];
}

function buildSignals(input: RouteInput): ComplexitySignals {
  return normalizeSignals({
    ...(input.signals ?? {}),
    role: input.signals?.role ?? input.role,
  });
}

/**
 * Route a session to adapter + model + tier (pure; no I/O).
 */
export function routeModel(input: RouteInput): RouteResult {
  const config = mergeModelsConfig(input.config);
  const adapters: AdapterRouteInfo[] =
    input.adapters && input.adapters.length > 0
      ? input.adapters
      : defaultAdaptersForRouting();
  const adaptersDefault = input.adapters_default ?? DEFAULT_ADAPTERS_DEFAULT;
  const preferenceOrder =
    input.preference_order && input.preference_order.length > 0
      ? input.preference_order
      : [...DEFAULT_PREFERENCE_ORDER];

  // 0. Deterministic shell path
  if (isDeterministicPath(input)) {
    return {
      session_kind: "deterministic",
      tier: null,
      adapter_id: "shell",
      model: "n/a",
      reason: "deterministic",
      floor_violated: false,
      pin_locked: false,
    };
  }

  const pins = resolvePins(input);

  // 1. routing_enabled == false → role floor (default medium), no estimator
  if (!config.routing_enabled) {
    // design: tier = role_tier_floor[role] ?? "medium"
    const disabledTier: ModelTier =
      config.role_tier_floor[input.role] ?? "medium";

    const picked = pickAdapter(
      pickArgs(disabledTier, pins, {
        preferred_adapters: input.preferred_adapters,
        adapters,
        adapters_default: adaptersDefault,
        preference_order: preferenceOrder,
        pin_locked: pins.pin_locked,
      }),
    );

    return finish({
      session_kind: "llm",
      tier: picked.tier,
      adapter_id: picked.adapter_id,
      model: picked.model,
      reason: "routing_disabled",
      floor_violated: false,
      pin_locked: pins.pin_locked,
      ...(picked.error !== undefined ? { error: picked.error } : {}),
    });
  }

  // 2–3. Estimate (with optional escalate replacement of step 3)
  const signals = buildSignals(input);
  const { score, tier: tierEst } = estimateComplexity(
    signals,
    config.complexity_weights,
    config.score_bands,
  );

  let tier: ModelTier = tierEst;
  let reason: RouteReason = "estimate";
  let escalated = false;

  if (
    input.escalate &&
    config.escalate_on_failure &&
    input.escalate.consecutive_quality_fails >=
      config.escalate_after_failures
  ) {
    const last = input.escalate.last_model_tier;
    if (last) {
      const bumped = nextTier(last);
      tier = maxTier(tierEst, bumped);
      if (tierIndex(tier) > tierIndex(tierEst)) {
        escalated = true;
        reason = "escalate";
      }
    } else {
      // No last tier: still max with next of estimate? Design says
      // max(tier_est, nextTier(last_model_tier)). Without last, only estimate.
    }
  }

  // Cap at max_tier on unpinned path seed (also applied after pins skip)
  tier = minTier(tier, config.max_tier);

  // 4a–c pins
  const modelOverride = pins.model_override;
  if (modelOverride) {
    // Lock model; tier = known tier for model if map has it, else leave estimate
    const inferred = inferTierForModel(modelOverride, adapters);
    if (inferred) tier = inferred;
    reason = "override";
  } else if (pins.tier_override) {
    tier = pins.tier_override;
    reason = "override";
  }

  const pin_locked = pins.pin_locked;
  const floor = roleFloor(input.role, config);
  const ceiling = roleCeiling(input.role, config);
  let floor_violated = false;
  let budgetCapped = false;

  // 4d role floor / ceiling — only if not pin_locked
  if (!pin_locked) {
    tier = maxTier(tier, floor);
    if (ceiling) tier = minTier(tier, ceiling);
    // re-apply max_tier after floor raise
    tier = minTier(tier, config.max_tier);
  }

  // 4e budget pressure — only if not pin_locked
  if (!pin_locked && input.budget_pressure) {
    const before = tier;
    tier = minTier(tier, config.budget_tier_cap);
    if (tierIndex(tier) < tierIndex(before) || tierIndex(tier) < tierIndex(floor)) {
      budgetCapped = true;
    }
    if (tierIndex(tier) < tierIndex(floor)) {
      floor_violated = true;
      if (config.strict_role_floors) {
        return {
          session_kind: "llm",
          score,
          tier,
          adapter_id: pins.adapter_override ?? adaptersDefault,
          model: "n/a",
          reason: "budget_cap",
          floor_violated: true,
          pin_locked: false,
          error: "strict_role_floors: budget_cap below role floor",
        };
      }
    }
    if (budgetCapped) reason = "budget_cap";
  }

  // If pin_locked, reason stays override (even after escalate seed)
  if (pin_locked) {
    reason = "override";
    floor_violated = false;
  } else if (escalated && reason !== "budget_cap") {
    reason = "escalate";
  }

  // 5–6 pickAdapter + model
  const picked = pickAdapter(
    pickArgs(
      tier,
      {
        ...(modelOverride !== undefined
          ? { model_override: modelOverride }
          : {}),
        ...(pins.adapter_override !== undefined
          ? { adapter_override: pins.adapter_override }
          : {}),
      },
      {
        preferred_adapters: input.preferred_adapters,
        adapters,
        adapters_default: adaptersDefault,
        preference_order: preferenceOrder,
        pin_locked,
      },
    ),
  );

  tier = picked.tier;

  if (picked.stepped_down && !pin_locked) {
    reason = "tier_map_gap";
    if (tierIndex(tier) < tierIndex(floor)) {
      floor_violated = true;
      if (config.strict_role_floors) {
        return {
          session_kind: "llm",
          score,
          tier,
          adapter_id: picked.adapter_id,
          model: picked.model,
          reason: "tier_map_gap",
          floor_violated: true,
          pin_locked: false,
          error: "strict_role_floors: tier_map_gap below role floor",
        };
      }
    }
  }

  // If model override applied, ensure model string is the pin
  const model =
    modelOverride && !picked.error ? modelOverride : picked.model;

  return finish({
    session_kind: "llm",
    score,
    tier,
    adapter_id: picked.adapter_id,
    model,
    reason,
    floor_violated,
    pin_locked,
    ...(picked.error !== undefined ? { error: picked.error } : {}),
  });
}

function finish(r: RouteResult): RouteResult {
  if (r.tier != null && r.effort === undefined) {
    return { ...r, effort: mapTierToEffort(r.tier) };
  }
  return r;
}

/** Alias used by dry-run / CLI / daemon. */
export const route = routeModel;
