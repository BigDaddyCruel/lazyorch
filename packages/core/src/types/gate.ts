export const GATE_TYPES = [
  "plan_approve",
  "plan_dispute",
  "plan_max_rounds",
  "task_approve",
  "merge",
  "destructive_git",
  "budget_override",
  "human_intervention",
] as const;

export type GateType = (typeof GATE_TYPES)[number];

const GATE_TYPE_SET = new Set<string>(GATE_TYPES);

export function isGateType(value: unknown): value is GateType {
  return typeof value === "string" && GATE_TYPE_SET.has(value);
}

export const GATE_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "timed_out",
] as const;

export type GateStatus = (typeof GATE_STATUSES)[number];

const GATE_STATUS_SET = new Set<string>(GATE_STATUSES);

export function isGateStatus(value: unknown): value is GateStatus {
  return typeof value === "string" && GATE_STATUS_SET.has(value);
}

/**
 * First-class gate entity that blocks progress until approve/reject/timeout.
 * ID: `gate_…`
 */
export interface Gate {
  id: string;
  type: GateType;
  run_id: string;
  status: GateStatus;
  created_at: string;
  timeout_at?: string;
  /** e.g. action for plan_max_rounds, task_ids for human_intervention */
  payload: Record<string, unknown>;
  resolved_at?: string;
  resolved_by?: string;
}
