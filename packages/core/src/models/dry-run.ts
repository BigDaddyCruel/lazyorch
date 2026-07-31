/**
 * Dry-run API helper for `lazyorch models route` / GET /v1/models/route.
 * Pure wrapper around routeModel — no persistence or session start.
 */

import { routeModel } from "./router.js";
import { toModelRoutedPayload } from "./events.js";
import type {
  ComplexitySignals,
  ModelPin,
  ModelRoutedPayload,
  PartialDeepModelsConfig,
  RouteInput,
  RouteResult,
  SessionKind,
} from "./types.js";

export interface DryRunRouteParams {
  role: string;
  task_id?: string;
  signals?: Partial<ComplexitySignals>;
  task_pin?: ModelPin;
  run_pin?: ModelPin;
  lead_pin?: ModelPin;
  session_kind?: SessionKind;
  budget_pressure?: boolean;
  preferred_adapters?: string[];
  config?: PartialDeepModelsConfig;
  /** Extra RouteInput fields when needed (adapters, escalate, …). */
  extra?: Partial<RouteInput>;
}

export interface DryRunRouteResult extends RouteResult {
  /** Payload ready for model.routed / HTTP response. */
  event: ModelRoutedPayload;
  dry_run: true;
}

/**
 * Dry-run the complexity router for a role/task query.
 * Returns the full RouteResult plus event payload.
 */
export function dryRunRoute(params: DryRunRouteParams): DryRunRouteResult {
  const input: RouteInput = {
    role: params.role,
    ...(params.extra ?? {}),
  };
  if (params.task_id !== undefined) input.task_id = params.task_id;
  if (params.signals !== undefined) input.signals = params.signals;
  if (params.task_pin !== undefined) input.task_pin = params.task_pin;
  if (params.run_pin !== undefined) input.run_pin = params.run_pin;
  if (params.lead_pin !== undefined) input.lead_pin = params.lead_pin;
  if (params.session_kind !== undefined) {
    input.session_kind = params.session_kind;
  }
  if (params.budget_pressure !== undefined) {
    input.budget_pressure = params.budget_pressure;
  }
  if (params.preferred_adapters !== undefined) {
    input.preferred_adapters = params.preferred_adapters;
  }
  if (params.config !== undefined) input.config = params.config;

  const result = routeModel(input);
  const eventOpts: { role: string; task_id?: string } = { role: params.role };
  if (params.task_id !== undefined) eventOpts.task_id = params.task_id;
  const event = toModelRoutedPayload(result, eventOpts);

  return {
    ...result,
    event,
    dry_run: true,
  };
}
