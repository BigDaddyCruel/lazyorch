/**
 * Terminal failed-task escalation (KD-36).
 *
 * When task is failed with attempt >= max_attempts:
 * - gate (default): open human_intervention, stay Implementing
 * - fail_run: run → Failed
 * - wait: no auto action
 */

import { generateId } from "@lazyorch/shared";
import { transitionRunPhase } from "../orchestrator/run-fsm.js";
import type { Gate } from "../types/gate.js";
import type { Run } from "../types/run.js";
import type { Task } from "../types/task.js";
import { ImplementingError } from "./outcomes.js";

export type OnTaskTerminalFailed = "gate" | "fail_run" | "wait";

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
}

export interface TerminalFailedResult {
  run: Run;
  gates: Gate[];
  /** Task ids that triggered the policy this call. */
  escalated_task_ids: string[];
}

/** Tasks that are terminal-failed (failed && attempt >= max_attempts). */
export function terminalFailedTasks(tasks: readonly Task[]): Task[] {
  return tasks.filter(
    (t) => t.status === "failed" && t.attempt >= t.max_attempts,
  );
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

/**
 * Apply KD-36 policy for terminal failed tasks.
 * Pure: returns new run + gates; does not mutate inputs.
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

  const ids = candidates.map((t) => t.id);

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
  const created = policy.now?.() ?? new Date().toISOString();
  const gate: Gate = {
    id: policy.nextGateId?.() ?? generateId("gate"),
    type: "human_intervention",
    run_id: run.id,
    status: "pending",
    created_at: created,
    payload: {
      task_ids: ids,
      reason: "task_attempts_exhausted",
    },
  };
  return { run, gates: [gate], escalated_task_ids: ids };
}
