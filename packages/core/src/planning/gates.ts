/**
 * Plan gate creation + resolve helpers (plan_approve / plan_dispute / plan_max_rounds).
 * Pure helpers — persistence via StateStore is the caller's job.
 */

import { generateId } from "@lazyorch/shared";
import { transitionRunPhase } from "../orchestrator/run-fsm.js";
import type { Gate, GateStatus } from "../types/gate.js";
import type { Run } from "../types/run.js";
import type { FreezeValidationError } from "./types.js";

const DEFAULT_TIMEOUT_NOTIFY_HOURS = 1;

function nowIso(now?: () => string): string {
  return now?.() ?? new Date().toISOString();
}

function nextGateId(nextId?: () => string): string {
  return nextId?.() ?? generateId("gate");
}

function timeoutAt(
  createdAt: string,
  timeoutNotifyHours: number = DEFAULT_TIMEOUT_NOTIFY_HOURS,
): string {
  const ms = Date.parse(createdAt) + timeoutNotifyHours * 3_600_000;
  return new Date(ms).toISOString();
}

export interface CreatePlanGateBase {
  run_id: string;
  plan_id: string;
  revision?: number;
  /** Hours until timeout_at notify (default 1). */
  timeout_notify_hours?: number;
  now?: () => string;
  nextId?: () => string;
}

/**
 * plan_approve — blocks leave PlanConsensus until human approves/rejects.
 * Payload: plan_id, freeze_hash?, revision?, residual_risks?
 */
export function createPlanApproveGate(
  opts: CreatePlanGateBase & {
    freeze_hash?: string;
    residual_risks?: string[];
  },
): Gate {
  const created_at = nowIso(opts.now);
  const payload: Record<string, unknown> = {
    plan_id: opts.plan_id,
  };
  if (opts.freeze_hash !== undefined) payload.freeze_hash = opts.freeze_hash;
  if (opts.revision !== undefined) payload.revision = opts.revision;
  if (opts.residual_risks !== undefined && opts.residual_risks.length > 0) {
    payload.residual_risks = [...opts.residual_risks];
  }
  return {
    id: nextGateId(opts.nextId),
    type: "plan_approve",
    run_id: opts.run_id,
    status: "pending",
    created_at,
    timeout_at: timeoutAt(created_at, opts.timeout_notify_hours),
    payload,
  };
}

/**
 * plan_dispute — blocks freeze while high/critical wontfix is re-opened.
 * Payload: plan_id, disputed_issue_ids, revision?
 */
export function createPlanDisputeGate(
  opts: CreatePlanGateBase & {
    disputed_issue_ids: readonly string[];
  },
): Gate {
  const created_at = nowIso(opts.now);
  const payload: Record<string, unknown> = {
    plan_id: opts.plan_id,
    disputed_issue_ids: [...opts.disputed_issue_ids],
  };
  if (opts.revision !== undefined) payload.revision = opts.revision;
  return {
    id: nextGateId(opts.nextId),
    type: "plan_dispute",
    run_id: opts.run_id,
    status: "pending",
    created_at,
    timeout_at: timeoutAt(created_at, opts.timeout_notify_hours),
    payload,
  };
}

/** Allowed actions for plan_max_rounds gate resolution. */
export const PLAN_MAX_ROUNDS_ACTIONS = [
  "force_approve",
  "edit",
  "abort",
] as const;
export type PlanMaxRoundsAction = (typeof PLAN_MAX_ROUNDS_ACTIONS)[number];

/**
 * plan_max_rounds — open when consensus exhausts rounds.
 * Payload lists allowed actions; human picks force_approve | edit | abort.
 */
export function createPlanMaxRoundsGate(
  opts: CreatePlanGateBase & {
    rounds: number;
    open_issues: number;
    validation_errors?: readonly FreezeValidationError[];
    /** Allowed actions advertised in payload (default all three). */
    actions?: readonly PlanMaxRoundsAction[];
  },
): Gate {
  const created_at = nowIso(opts.now);
  const actions = opts.actions ?? [...PLAN_MAX_ROUNDS_ACTIONS];
  const payload: Record<string, unknown> = {
    plan_id: opts.plan_id,
    rounds: opts.rounds,
    open_issues: opts.open_issues,
    actions: [...actions],
  };
  if (opts.revision !== undefined) payload.revision = opts.revision;
  if (opts.validation_errors !== undefined && opts.validation_errors.length > 0) {
    payload.validation_errors = opts.validation_errors.map((e) => ({ ...e }));
  }
  return {
    id: nextGateId(opts.nextId),
    type: "plan_max_rounds",
    run_id: opts.run_id,
    status: "pending",
    created_at,
    timeout_at: timeoutAt(created_at, opts.timeout_notify_hours),
    payload,
  };
}

export interface ResolveGateOptions {
  resolved_by?: string;
  /** Extra payload fields merged (e.g. action for plan_max_rounds). */
  payload?: Record<string, unknown>;
  now?: () => string;
}

/** Build resolve options without passing explicit undefined (exactOptionalPropertyTypes). */
function resolveOpts(
  nowFn: () => string,
  resolved_by?: string,
  payload?: Record<string, unknown>,
): ResolveGateOptions {
  const o: ResolveGateOptions = { now: nowFn };
  if (resolved_by !== undefined) o.resolved_by = resolved_by;
  if (payload !== undefined) o.payload = payload;
  return o;
}

/** Mark a gate resolved (approved | rejected | timed_out). */
export function resolveGate(
  gate: Gate,
  status: Exclude<GateStatus, "pending">,
  opts?: ResolveGateOptions,
): Gate {
  const resolved_at = nowIso(opts?.now);
  const next: Gate = {
    ...gate,
    status,
    resolved_at,
    payload: opts?.payload
      ? { ...gate.payload, ...opts.payload }
      : { ...gate.payload },
  };
  if (opts?.resolved_by !== undefined) next.resolved_by = opts.resolved_by;
  return next;
}

export type PlanRejectAction = "cancel" | "revise";

export interface ResolvePlanApproveResult {
  gate: Gate;
  run: Run;
}

/**
 * Apply plan_approve decision to run FSM:
 * - approve → PlanConsensus → Implementing
 * - reject + cancel → Cancelled
 * - reject + revise → Planning
 */
export function applyPlanApproveDecision(
  run: Run,
  gate: Gate,
  decision: "approve" | "reject",
  opts?: {
    plan_reject_action?: PlanRejectAction;
    resolved_by?: string;
    now?: () => string;
  },
): ResolvePlanApproveResult {
  if (gate.type !== "plan_approve") {
    throw new Error(`applyPlanApproveDecision requires plan_approve, got ${gate.type}`);
  }
  const ts = nowIso(opts?.now);
  const nowFn = () => ts;
  if (decision === "approve") {
    let nextRun = run;
    if (run.phase === "PlanConsensus") {
      nextRun = transitionRunPhase(run, "Implementing", { updated_at: ts });
    } else if (run.phase !== "Implementing") {
      throw new Error(
        `plan_approve approve requires PlanConsensus, got ${run.phase}`,
      );
    }
    return {
      gate: resolveGate(
        gate,
        "approved",
        resolveOpts(nowFn, opts?.resolved_by),
      ),
      run: nextRun,
    };
  }

  // reject
  const action: PlanRejectAction = opts?.plan_reject_action ?? "cancel";
  let nextRun = run;
  if (action === "revise") {
    if (run.phase === "PlanConsensus" || run.phase === "Planning") {
      if (run.phase === "PlanConsensus") {
        nextRun = transitionRunPhase(run, "Planning", { updated_at: ts });
      }
    } else {
      throw new Error(
        `plan_approve revise requires PlanConsensus/Planning, got ${run.phase}`,
      );
    }
  } else {
    // cancel
    if (run.phase === "PlanConsensus" || run.phase === "Planning") {
      nextRun = transitionRunPhase(run, "Cancelled", {
        updated_at: ts,
        cancelled_reason: "plan_approve rejected",
      });
    } else {
      throw new Error(
        `plan_approve cancel requires PlanConsensus/Planning, got ${run.phase}`,
      );
    }
  }
  return {
    gate: resolveGate(
      gate,
      "rejected",
      resolveOpts(nowFn, opts?.resolved_by, { reject_action: action }),
    ),
    run: nextRun,
  };
}

export type PlanDisputeResolution =
  | "accept_wontfix"
  | "force_addressed"
  | "abort";

export interface ResolvePlanDisputeResult {
  gate: Gate;
  run: Run;
  /** When abort: run is Cancelled. Otherwise stays Planning for resume. */
  resolution: PlanDisputeResolution;
}

/**
 * Apply plan_dispute resolution:
 * - accept_wontfix / force_addressed → approve gate, stay Planning (caller resumes consensus)
 * - abort → Cancelled
 */
export function applyPlanDisputeDecision(
  run: Run,
  gate: Gate,
  resolution: PlanDisputeResolution,
  opts?: {
    resolved_by?: string;
    now?: () => string;
  },
): ResolvePlanDisputeResult {
  if (gate.type !== "plan_dispute") {
    throw new Error(`applyPlanDisputeDecision requires plan_dispute, got ${gate.type}`);
  }
  const ts = nowIso(opts?.now);
  const nowFn = () => ts;

  if (resolution === "abort") {
    let nextRun = run;
    if (run.phase === "Planning" || run.phase === "PlanConsensus") {
      nextRun = transitionRunPhase(run, "Cancelled", {
        updated_at: ts,
        cancelled_reason: "plan_dispute aborted",
      });
    }
    return {
      gate: resolveGate(
        gate,
        "rejected",
        resolveOpts(nowFn, opts?.resolved_by, { resolution }),
      ),
      run: nextRun,
      resolution,
    };
  }

  return {
    gate: resolveGate(
      gate,
      "approved",
      resolveOpts(nowFn, opts?.resolved_by, { resolution }),
    ),
    run,
    resolution,
  };
}

export interface ResolvePlanMaxRoundsResult {
  gate: Gate;
  run: Run;
  action: PlanMaxRoundsAction;
}

/**
 * Apply plan_max_rounds action:
 * - force_approve → gate approved (caller runs completeForceApprove → PlanConsensus)
 * - edit → gate approved, stay Planning
 * - abort → gate rejected, run → Cancelled
 */
export function applyPlanMaxRoundsDecision(
  run: Run,
  gate: Gate,
  action: PlanMaxRoundsAction,
  opts?: {
    resolved_by?: string;
    now?: () => string;
  },
): ResolvePlanMaxRoundsResult {
  if (gate.type !== "plan_max_rounds") {
    throw new Error(
      `applyPlanMaxRoundsDecision requires plan_max_rounds, got ${gate.type}`,
    );
  }
  const ts = nowIso(opts?.now);
  const nowFn = () => ts;

  if (action === "abort") {
    let nextRun = run;
    if (run.phase === "Planning" || run.phase === "PlanConsensus") {
      nextRun = transitionRunPhase(run, "Cancelled", {
        updated_at: ts,
        cancelled_reason: "plan_max_rounds abort",
      });
    }
    return {
      gate: resolveGate(
        gate,
        "rejected",
        resolveOpts(nowFn, opts?.resolved_by, { action }),
      ),
      run: nextRun,
      action,
    };
  }

  // force_approve | edit — approved; freeze / re-review is caller's job
  return {
    gate: resolveGate(
      gate,
      "approved",
      resolveOpts(nowFn, opts?.resolved_by, { action }),
    ),
    run,
    action,
  };
}

/**
 * Whether plan_approve gate should be opened after freeze.
 * False when gates.plan_approve is disabled (auto path).
 */
export function shouldOpenPlanApproveGate(
  gatesConfig: { plan_approve?: boolean } | undefined,
): boolean {
  return gatesConfig?.plan_approve !== false;
}
