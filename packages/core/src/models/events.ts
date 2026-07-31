/**
 * model.routed event payload helper (pure result shape).
 */

import type { ModelRoutedPayload, RouteResult } from "./types.js";

/**
 * Build the `model.routed` payload from a RouteResult.
 * Omits floor_violated when false/absent so intentional pins stay clean.
 */
export function toModelRoutedPayload(
  result: RouteResult,
  opts: { task_id?: string; role: string } = { role: "worker" },
): ModelRoutedPayload {
  const payload: ModelRoutedPayload = {
    role: opts.role,
    adapter_id: result.adapter_id,
    model: result.model,
    reason: result.reason,
  };

  const taskId = opts.task_id;
  if (taskId !== undefined) payload.task_id = taskId;

  if (result.score !== undefined) payload.score = result.score;

  // tier is null on deterministic path — still include for observability
  payload.tier = result.tier;

  if (result.floor_violated) {
    payload.floor_violated = true;
  }

  return payload;
}

/** Event type constant for emitters. */
export const MODEL_ROUTED_EVENT = "model.routed" as const;

/**
 * Emit-shaped object: type + payload (daemon EventEnvelope builds the rest).
 */
export function modelRoutedEvent(
  result: RouteResult,
  opts: { task_id?: string; role: string },
): { type: typeof MODEL_ROUTED_EVENT; payload: ModelRoutedPayload } {
  return {
    type: MODEL_ROUTED_EVENT,
    payload: toModelRoutedPayload(result, opts),
  };
}
