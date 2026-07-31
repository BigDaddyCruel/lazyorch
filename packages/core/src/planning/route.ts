/**
 * Model routing for plan_writer / plan_reviewer sessions (large floors).
 */

import {
  routeModel,
  type ComplexitySignals,
  type RouteInput,
  type RouteResult,
} from "../models/index.js";
import type { Agent } from "../types/agent.js";
import type { PlanningRole, PlanningRoutingOptions } from "./ports.js";

/** Default complexity signals for a planning role (no task yet). */
export function planningSignals(
  role: PlanningRole,
  overrides?: Partial<ComplexitySignals>,
): ComplexitySignals {
  return {
    task_type_labels: ["plan"],
    scope_path_count: 0,
    depends_on_count: 0,
    is_critical_path: true,
    prior_failures: 0,
    risk_labels: [],
    acceptance_command_count: 0,
    title_desc_chars: 0,
    ...overrides,
    // Force planning identity last so overrides cannot clobber floors/estimator role.
    role,
    task_origin: "plan",
  };
}

export interface RoutePlanningSessionParams {
  role: PlanningRole;
  agent?: Agent;
  preferred_adapters?: readonly string[];
  routing?: PlanningRoutingOptions;
  signals?: Partial<ComplexitySignals>;
  /** Task-level pin (rare for planning; usually run/lead only). */
  task_pin?: RouteInput["task_pin"];
}

/**
 * Route plan_writer / plan_reviewer through the model router.
 * Floors default to large (DEFAULT_ROLE_TIER_FLOOR).
 */
export function routePlanningSession(
  params: RoutePlanningSessionParams,
): RouteResult {
  const { role, routing } = params;
  const preferred =
    params.preferred_adapters ??
    routing?.preferred_adapters_by_role?.[role] ??
    params.agent?.preferred_adapters ??
    [];

  const input: RouteInput = {
    role,
    session_kind: "llm",
    signals: planningSignals(role, params.signals),
  };
  if (preferred.length > 0) {
    input.preferred_adapters = [...preferred];
  }
  if (routing?.config !== undefined) {
    input.config = routing.config;
  }
  if (routing?.adapters !== undefined) {
    input.adapters = routing.adapters;
  }
  if (routing?.adapters_default !== undefined) {
    input.adapters_default = routing.adapters_default;
  }
  if (routing?.preference_order !== undefined) {
    input.preference_order = routing.preference_order;
  }
  if (routing?.run_pin !== undefined) {
    input.run_pin = routing.run_pin;
  }
  if (routing?.lead_pin !== undefined) {
    input.lead_pin = routing.lead_pin;
  }
  if (params.task_pin !== undefined) {
    input.task_pin = params.task_pin;
  }
  if (routing?.budget_pressure !== undefined) {
    input.budget_pressure = routing.budget_pressure;
  }

  const routeFn = routing?.routeFn ?? routeModel;
  return routeFn(input);
}
