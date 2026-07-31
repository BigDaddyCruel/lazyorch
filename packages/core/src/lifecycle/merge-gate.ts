/**
 * Merge gate helpers (human approve path → forge merge).
 * Mirrors planning gates style — pure FSM + gate entities.
 */

import { generateId } from "@lazyorch/shared";
import {
  createDynamicFixTasks,
  invalidateRunQa,
} from "../implementing/qa.js";
import { transitionRunPhase } from "../orchestrator/run-fsm.js";
import { resolveGate } from "../planning/gates.js";
import type { Gate } from "../types/gate.js";
import type { Run } from "../types/run.js";
import type { Task } from "../types/task.js";

const DEFAULT_TIMEOUT_NOTIFY_HOURS = 1;

function nowIso(now?: () => string): string {
  return now?.() ?? new Date().toISOString();
}

function timeoutAt(
  createdAt: string,
  timeoutNotifyHours: number = DEFAULT_TIMEOUT_NOTIFY_HOURS,
): string {
  const ms = Date.parse(createdAt) + timeoutNotifyHours * 3_600_000;
  return new Date(ms).toISOString();
}

export interface CreateMergeGateOpts {
  run_id: string;
  pr_number: number;
  pr_url?: string;
  head_sha?: string;
  timeout_notify_hours?: number;
  now?: () => string;
  nextId?: () => string;
}

/**
 * Open merge gate blocking MergeReady → Merged when merge_gate: human.
 * Payload: pr_number, pr_url?, head_sha?
 */
export function createMergeGate(opts: CreateMergeGateOpts): Gate {
  const created_at = nowIso(opts.now);
  const payload: Record<string, unknown> = {
    pr_number: opts.pr_number,
  };
  if (opts.pr_url !== undefined) payload.pr_url = opts.pr_url;
  if (opts.head_sha !== undefined) payload.head_sha = opts.head_sha;

  return {
    id: opts.nextId?.() ?? generateId("gate"),
    type: "merge",
    run_id: opts.run_id,
    status: "pending",
    created_at,
    timeout_at: timeoutAt(created_at, opts.timeout_notify_hours),
    payload,
  };
}

/** True when a pending merge gate already exists for this run/PR. */
export function hasPendingMergeGate(
  gates: readonly Gate[],
  runId: string,
  prNumber?: number,
): boolean {
  return gates.some((g) => {
    if (g.type !== "merge" || g.status !== "pending" || g.run_id !== runId) {
      return false;
    }
    if (prNumber === undefined) return true;
    return g.payload.pr_number === prNumber;
  });
}

export type MergeGateDecision = "approve" | "reject";

export interface ApplyMergeGateDecisionResult {
  gate: Gate;
  run: Run;
  /** True when caller should invoke forge merge (approve path). */
  should_merge: boolean;
}

/**
 * Apply human merge gate decision:
 * - approve → should_merge true (caller merges then → Merged); gate approved
 * - reject → stay MergeReady; gate rejected (optional comment in payload)
 *
 * Does not call forge itself (port is caller's job).
 */
export function applyMergeGateDecision(
  run: Run,
  gate: Gate,
  decision: MergeGateDecision,
  opts?: {
    resolved_by?: string;
    comment?: string;
    now?: () => string;
  },
): ApplyMergeGateDecisionResult {
  if (gate.type !== "merge") {
    throw new Error(
      `applyMergeGateDecision requires merge gate, got ${gate.type}`,
    );
  }
  if (gate.status !== "pending") {
    throw new Error(
      `applyMergeGateDecision: gate ${gate.id} is ${gate.status}`,
    );
  }
  if (gate.run_id !== run.id) {
    throw new Error(
      `applyMergeGateDecision: gate.run_id ${gate.run_id} !== run.id ${run.id}`,
    );
  }
  if (run.phase !== "MergeReady") {
    throw new Error(
      `applyMergeGateDecision requires MergeReady, got ${run.phase}`,
    );
  }

  const ts = nowIso(opts?.now);
  const nowFn = () => ts;
  const extra: Record<string, unknown> = {};
  if (opts?.comment !== undefined) extra.comment = opts.comment;

  if (decision === "approve") {
    return {
      gate: resolveGate(gate, "approved", {
        now: nowFn,
        require_pending: true,
        ...(opts?.resolved_by !== undefined
          ? { resolved_by: opts.resolved_by }
          : {}),
        ...(Object.keys(extra).length > 0 ? { payload: extra } : {}),
      }),
      run,
      should_merge: true,
    };
  }

  return {
    gate: resolveGate(gate, "rejected", {
      now: nowFn,
      require_pending: true,
      ...(opts?.resolved_by !== undefined
        ? { resolved_by: opts.resolved_by }
        : {}),
      ...(Object.keys(extra).length > 0 ? { payload: extra } : {}),
    }),
    run,
    should_merge: false,
  };
}

/**
 * After successful forge merge: run → Merged and pr_ref.state = merged.
 */
export function applyMerged(
  run: Run,
  opts?: { sha?: string; now?: () => string },
): Run {
  if (run.phase !== "MergeReady") {
    throw new Error(`applyMerged requires MergeReady, got ${run.phase}`);
  }
  const ts = nowIso(opts?.now);
  let next = transitionRunPhase(run, "Merged", { updated_at: ts });
  if (next.pr_ref) {
    next = {
      ...next,
      pr_ref: {
        ...next.pr_ref,
        state: "merged",
        ...(opts?.sha !== undefined ? { head_sha: opts.sha } : {}),
      },
    };
  }
  return next;
}

/**
 * Whether merge may proceed without a human gate (merge_gate: auto or gates.merge false).
 */
export function shouldAutoMerge(opts: {
  merge_gate: "human" | "auto";
  gates_merge: boolean;
}): boolean {
  if (opts.merge_gate === "auto") return true;
  if (!opts.gates_merge) return true;
  return false;
}

/**
 * Approve all pending merge gates for a run/PR (used when forge merge succeeds
 * via auto or merge_approved without an earlier applyMergeGateDecision).
 */
export function resolvePendingMergeGates(
  gates: readonly Gate[],
  runId: string,
  opts?: {
    pr_number?: number;
    resolved_by?: string;
    now?: () => string;
  },
): Gate[] {
  const ts = nowIso(opts?.now);
  const nowFn = () => ts;
  return gates.map((g) => {
    if (g.type !== "merge" || g.status !== "pending" || g.run_id !== runId) {
      return g;
    }
    if (
      opts?.pr_number !== undefined &&
      g.payload.pr_number !== opts.pr_number
    ) {
      return g;
    }
    return resolveGate(g, "approved", {
      now: nowFn,
      require_pending: true,
      ...(opts?.resolved_by !== undefined
        ? { resolved_by: opts.resolved_by }
        : { resolved_by: "system" }),
      payload: { resolved_via: "merge_success" },
    });
  });
}

export interface ApplyChangesRequestedOpts {
  summary?: string;
  now?: () => string;
  nextTaskId?: () => string;
  scope?: readonly string[];
}

export interface ApplyChangesRequestedResult {
  run: Run;
  tasks: Task[];
  fix_tasks: Task[];
}

/**
 * MergeReady → Implementing with dynamic "changes requested" tasks.
 * Invalidates run-level QA so re-exit requires re-QA at tip.
 */
export function applyChangesRequested(
  run: Run,
  tasks: readonly Task[],
  opts?: ApplyChangesRequestedOpts,
): ApplyChangesRequestedResult {
  if (run.phase !== "MergeReady") {
    throw new Error(
      `applyChangesRequested requires MergeReady, got ${run.phase}`,
    );
  }
  const ts = nowIso(opts?.now);
  const fix_tasks = createDynamicFixTasks({
    run_id: run.id,
    reason: "changes_requested",
    summary: opts?.summary ?? "Changes requested on PR",
    ...(opts?.scope !== undefined ? { scope: opts.scope } : {}),
    ...(opts?.nextTaskId !== undefined
      ? { nextTaskId: opts.nextTaskId }
      : {}),
  });
  let next = transitionRunPhase(run, "Implementing", { updated_at: ts });
  next = invalidateRunQa(next, () => ts);
  return {
    run: next,
    tasks: [...tasks, ...fix_tasks],
    fix_tasks,
  };
}
