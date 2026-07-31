/**
 * Terminal failed-task escalation (KD-36) + conflict-storm gates.
 *
 * When task is failed with attempt >= max_attempts:
 * - gate (default): open human_intervention, stay Implementing
 * - fail_run: run → Failed
 * - wait: no auto action
 *
 * Gate creation is idempotent: pending human_intervention gates covering
 * the same task ids / reasons are not duplicated.
 */

import { generateId } from "@lazyorch/shared";
import { transitionRunPhase } from "../orchestrator/run-fsm.js";
import type { Gate } from "../types/gate.js";
import type { Run } from "../types/run.js";
import type { Task } from "../types/task.js";
import { ImplementingError } from "./outcomes.js";

export type OnTaskTerminalFailed = "gate" | "fail_run" | "wait";

export type HumanInterventionReason =
  | "task_attempts_exhausted"
  | "integrate_conflict_storm";

export interface TerminalFailedPolicy {
  on_task_terminal_failed?: OnTaskTerminalFailed;
  /** Grace ms after entering failed before policy (default 0). */
  failed_escalation_ms?: number;
  /**
   * task_id → ms when entered terminal failed (for grace).
   * When omitted and grace > 0, tasks are not yet escalated.
   */
  failed_at_ms?: ReadonlyMap<string, number>;
  now_ms?: number;
  now?: () => string;
  nextGateId?: () => string;
  /**
   * Already-open gates for this run. Pending `human_intervention` gates
   * suppress re-open for covered task_ids (idempotency).
   */
  existing_gates?: readonly Gate[];
  /** Explicit set of task ids already escalated this run. */
  already_escalated_task_ids?: ReadonlySet<string>;
}

export interface TerminalFailedResult {
  run: Run;
  gates: Gate[];
  /** Task ids that triggered a new gate / fail_run this call. */
  escalated_task_ids: string[];
}

/** Tasks that are terminal-failed (failed && attempt >= max_attempts). */
export function terminalFailedTasks(tasks: readonly Task[]): Task[] {
  return tasks.filter(
    (t) => t.status === "failed" && t.attempt >= t.max_attempts,
  );
}

/**
 * Task ids already covered by a pending human_intervention gate
 * (optionally filtered by reason).
 */
export function coveredByPendingIntervention(
  gates: readonly Gate[] | undefined,
  reason?: HumanInterventionReason,
): Set<string> {
  const covered = new Set<string>();
  if (!gates) return covered;
  for (const g of gates) {
    if (g.status !== "pending" || g.type !== "human_intervention") continue;
    const payloadReason = g.payload.reason;
    if (
      reason !== undefined &&
      payloadReason !== undefined &&
      payloadReason !== reason
    ) {
      continue;
    }
    const ids = g.payload.task_ids;
    if (Array.isArray(ids)) {
      for (const id of ids) {
        if (typeof id === "string") covered.add(id);
      }
    }
  }
  return covered;
}

function withinGrace(
  taskId: string,
  policy: TerminalFailedPolicy,
): boolean {
  const grace = policy.failed_escalation_ms ?? 0;
  if (grace <= 0) return false;
  const now = policy.now_ms ?? Date.now();
  const entered = policy.failed_at_ms?.get(taskId);
  if (entered === undefined) return true; // unknown → wait for stamp
  return now - entered < grace;
}

function filterNewEscalations(
  ids: readonly string[],
  policy: TerminalFailedPolicy,
  reason: HumanInterventionReason,
): string[] {
  const covered = coveredByPendingIntervention(policy.existing_gates, reason);
  // Also honor gates with any human_intervention covering the id
  const anyCovered = coveredByPendingIntervention(policy.existing_gates);
  const already = policy.already_escalated_task_ids;
  return ids.filter((id) => {
    if (already?.has(id)) return false;
    if (covered.has(id) || anyCovered.has(id)) return false;
    return true;
  });
}

/**
 * Apply KD-36 policy for terminal failed tasks.
 * Pure: returns new run + gates; does not mutate inputs.
 * Idempotent: skips task ids already covered by pending human_intervention.
 */
export function applyTerminalFailedPolicy(
  run: Run,
  tasks: readonly Task[],
  policy: TerminalFailedPolicy = {},
): TerminalFailedResult {
  if (run.phase !== "Implementing") {
    throw new ImplementingError(
      "invalid_phase",
      `applyTerminalFailedPolicy requires Implementing, got ${run.phase}`,
    );
  }

  const mode: OnTaskTerminalFailed =
    policy.on_task_terminal_failed ?? "gate";
  const candidates = terminalFailedTasks(tasks).filter(
    (t) => !withinGrace(t.id, policy),
  );

  if (candidates.length === 0) {
    return { run, gates: [], escalated_task_ids: [] };
  }

  const ids = filterNewEscalations(
    candidates.map((t) => t.id),
    policy,
    "task_attempts_exhausted",
  );

  if (ids.length === 0) {
    return { run, gates: [], escalated_task_ids: [] };
  }

  if (mode === "wait") {
    return { run, gates: [], escalated_task_ids: [] };
  }

  if (mode === "fail_run") {
    const ts = policy.now?.() ?? new Date().toISOString();
    const next = transitionRunPhase(run, "Failed", {
      updated_at: ts,
      failed_reason: `task_attempts_exhausted: ${ids.join(",")}`,
    });
    return { run: next, gates: [], escalated_task_ids: ids };
  }

  // gate (default)
  return {
    run,
    gates: [
      createHumanInterventionGate({
        run_id: run.id,
        task_ids: ids,
        reason: "task_attempts_exhausted",
        ...(policy.now !== undefined ? { now: policy.now } : {}),
        ...(policy.nextGateId !== undefined
          ? { nextGateId: policy.nextGateId }
          : {}),
      }),
    ],
    escalated_task_ids: ids,
  };
}

export interface CreateHumanInterventionGateOpts {
  run_id: string;
  task_ids: readonly string[];
  reason: HumanInterventionReason;
  now?: () => string;
  nextGateId?: () => string;
}

/** Build a pending human_intervention gate. */
export function createHumanInterventionGate(
  opts: CreateHumanInterventionGateOpts,
): Gate {
  const created = opts.now?.() ?? new Date().toISOString();
  return {
    id: opts.nextGateId?.() ?? generateId("gate"),
    type: "human_intervention",
    run_id: opts.run_id,
    status: "pending",
    created_at: created,
    payload: {
      task_ids: [...opts.task_ids],
      reason: opts.reason,
    },
  };
}

/**
 * Open human_intervention for integrate conflict storm (KD-34 repeated
 * conflicts at max_attempts). Idempotent vs existing pending gates.
 */
export function applyConflictStormPolicy(
  run: Run,
  stormTaskIds: readonly string[],
  policy: Pick<
    TerminalFailedPolicy,
    "existing_gates" | "already_escalated_task_ids" | "now" | "nextGateId"
  > = {},
): { gates: Gate[]; escalated_task_ids: string[] } {
  if (stormTaskIds.length === 0) {
    return { gates: [], escalated_task_ids: [] };
  }
  const ids = filterNewEscalations(
    stormTaskIds,
    policy,
    "integrate_conflict_storm",
  );
  if (ids.length === 0) {
    return { gates: [], escalated_task_ids: [] };
  }
  return {
    gates: [
      createHumanInterventionGate({
        run_id: run.id,
        task_ids: ids,
        reason: "integrate_conflict_storm",
        ...(policy.now !== undefined ? { now: policy.now } : {}),
        ...(policy.nextGateId !== undefined
          ? { nextGateId: policy.nextGateId }
          : {}),
      }),
    ],
    escalated_task_ids: ids,
  };
}
