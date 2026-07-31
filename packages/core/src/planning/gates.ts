/**
 * Plan gate creation + resolve helpers (plan_approve / plan_dispute / plan_max_rounds).
 * Pure helpers — persistence via StateStore is the caller's job.
 */

import { generateId } from "@lazyorch/shared";
import { transitionRunPhase } from "../orchestrator/run-fsm.js";
import type { Gate, GateStatus } from "../types/gate.js";
import type { Run } from "../types/run.js";
import type {
  FreezeValidationError,
  FrozenPlanResult,
} from "./types.js";

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

/** Shared preconditions for apply* helpers. */
function assertPendingGate(gate: Gate, fn: string): void {
  if (gate.status !== "pending") {
    throw new Error(
      `${fn}: gate ${gate.id} is ${gate.status}, expected pending`,
    );
  }
}

function assertGateRunMatch(gate: Gate, run: Run, fn: string): void {
  if (gate.run_id !== run.id) {
    throw new Error(
      `${fn}: gate.run_id ${gate.run_id} !== run.id ${run.id}`,
    );
  }
}

function assertPlanningPhase(
  run: Run,
  fn: string,
  allowed: ReadonlySet<string>,
): void {
  if (!allowed.has(run.phase)) {
    throw new Error(
      `${fn}: requires phase ${[...allowed].join("|")}, got ${run.phase}`,
    );
  }
}

const PLANNING_OR_CONSENSUS = new Set(["Planning", "PlanConsensus"]);

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

const PLAN_MAX_ROUNDS_ACTION_SET = new Set<string>(PLAN_MAX_ROUNDS_ACTIONS);

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

/**
 * Allowed actions for a plan_max_rounds gate (payload.actions or full set).
 */
export function allowedPlanMaxRoundsActions(
  gate: Gate,
): readonly PlanMaxRoundsAction[] {
  const raw = gate.payload.actions;
  if (Array.isArray(raw) && raw.length > 0) {
    const filtered = raw.filter(
      (a): a is PlanMaxRoundsAction =>
        typeof a === "string" && PLAN_MAX_ROUNDS_ACTION_SET.has(a),
    );
    if (filtered.length > 0) return filtered;
  }
  return PLAN_MAX_ROUNDS_ACTIONS;
}

export interface ResolveGateOptions {
  resolved_by?: string;
  /** Extra payload fields merged (e.g. action for plan_max_rounds). */
  payload?: Record<string, unknown>;
  now?: () => string;
  /**
   * When true (default for apply* helpers), reject non-pending gates.
   * Low-level resolveGate defaults false so callers can force-mark timed_out.
   */
  require_pending?: boolean;
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

/**
 * Mark a gate resolved (approved | rejected | timed_out).
 * Apply* helpers enforce pending first; set require_pending:true for strict use.
 */
export function resolveGate(
  gate: Gate,
  status: Exclude<GateStatus, "pending">,
  opts?: ResolveGateOptions,
): Gate {
  if (opts?.require_pending === true && gate.status !== "pending") {
    throw new Error(
      `resolveGate: gate ${gate.id} is ${gate.status}, expected pending`,
    );
  }
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
    throw new Error(
      `applyPlanApproveDecision requires plan_approve, got ${gate.type}`,
    );
  }
  assertPendingGate(gate, "applyPlanApproveDecision");
  assertGateRunMatch(gate, run, "applyPlanApproveDecision");

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
    throw new Error(
      `applyPlanDisputeDecision requires plan_dispute, got ${gate.type}`,
    );
  }
  assertPendingGate(gate, "applyPlanDisputeDecision");
  assertGateRunMatch(gate, run, "applyPlanDisputeDecision");

  const ts = nowIso(opts?.now);
  const nowFn = () => ts;

  if (resolution === "abort") {
    assertPlanningPhase(
      run,
      "applyPlanDisputeDecision abort",
      PLANNING_OR_CONSENSUS,
    );
    const nextRun = transitionRunPhase(run, "Cancelled", {
      updated_at: ts,
      cancelled_reason: "plan_dispute aborted",
    });
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

  // accept_wontfix / force_addressed — stay in Planning for resume
  assertPlanningPhase(
    run,
    "applyPlanDisputeDecision",
    PLANNING_OR_CONSENSUS,
  );

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
  assertPendingGate(gate, "applyPlanMaxRoundsDecision");
  assertGateRunMatch(gate, run, "applyPlanMaxRoundsDecision");

  const allowed = allowedPlanMaxRoundsActions(gate);
  if (!allowed.includes(action)) {
    throw new Error(
      `applyPlanMaxRoundsDecision: action ${action} not in allowed [${allowed.join(", ")}]`,
    );
  }

  const ts = nowIso(opts?.now);
  const nowFn = () => ts;

  if (action === "abort") {
    assertPlanningPhase(
      run,
      "applyPlanMaxRoundsDecision abort",
      PLANNING_OR_CONSENSUS,
    );
    const nextRun = transitionRunPhase(run, "Cancelled", {
      updated_at: ts,
      cancelled_reason: "plan_max_rounds abort",
    });
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
  assertPlanningPhase(
    run,
    "applyPlanMaxRoundsDecision",
    PLANNING_OR_CONSENSUS,
  );

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

/**
 * Auto-advance PlanConsensus → Implementing when plan_approve is disabled.
 * No-op when already Implementing; throws if phase is anything else.
 */
export function autoAdvanceAfterPlanFreeze(
  run: Run,
  opts?: { now?: () => string },
): Run {
  if (run.phase === "Implementing") return run;
  if (run.phase !== "PlanConsensus") {
    throw new Error(
      `autoAdvanceAfterPlanFreeze requires PlanConsensus, got ${run.phase}`,
    );
  }
  const ts = nowIso(opts?.now);
  return transitionRunPhase(run, "Implementing", { updated_at: ts });
}

export interface OpenGatesAfterForceApproveOpts {
  /** gates.plan_approve (default true → open gate; false → auto Implementing). */
  plan_approve?: boolean;
  now?: () => string;
  nextId?: () => string;
}

export interface OpenGatesAfterForceApproveResult {
  run: Run;
  gates: Gate[];
}

/**
 * After plan_max_rounds force_approve + completeForceApprove freeze:
 * - plan_approve enabled (default) → open plan_approve gate, stay PlanConsensus
 * - plan_approve disabled → auto-advance PlanConsensus → Implementing
 */
export function openGatesAfterForceApprove(
  run: Run,
  frozen: FrozenPlanResult,
  opts?: OpenGatesAfterForceApproveOpts,
): OpenGatesAfterForceApproveResult {
  if (frozen.status !== "frozen") {
    throw new Error(
      `openGatesAfterForceApprove requires frozen result, got ${frozen.status}`,
    );
  }
  if (run.phase !== "PlanConsensus" && run.phase !== "Implementing") {
    throw new Error(
      `openGatesAfterForceApprove requires PlanConsensus (post-freeze), got ${run.phase}`,
    );
  }

  if (!shouldOpenPlanApproveGate(opts)) {
    const advanced = autoAdvanceAfterPlanFreeze(run, {
      ...(opts?.now !== undefined ? { now: opts.now } : {}),
    });
    return { run: advanced, gates: [] };
  }

  const gateOpts: CreatePlanGateBase & {
    freeze_hash?: string;
    residual_risks?: string[];
  } = {
    run_id: run.id,
    plan_id: frozen.plan.id,
    revision: frozen.plan.revision,
    freeze_hash: frozen.freeze_hash,
  };
  if (opts?.now !== undefined) gateOpts.now = opts.now;
  if (opts?.nextId !== undefined) gateOpts.nextId = opts.nextId;
  if (
    frozen.plan.residual_risks !== undefined &&
    frozen.plan.residual_risks.length > 0
  ) {
    gateOpts.residual_risks = frozen.plan.residual_risks;
  }

  return {
    run,
    gates: [createPlanApproveGate(gateOpts)],
  };
}
