import type { PrRef, Run, RunPhase } from "../types/run.js";

export class RunFsmError extends Error {
  readonly code: "invalid_transition" | "terminal";

  constructor(code: RunFsmError["code"], message: string) {
    super(message);
    this.name = "RunFsmError";
    this.code = code;
  }
}

/**
 * Allowed run-phase transitions (design-lazyorch two-layer FSM).
 *
 * Terminals: Merged, Cancelled, Failed.
 * Self-edges (Planning → Planning) model internal plan rounds.
 *
 * Implementing exits:
 * - → PrePR when exit predicate met and no ready PR
 * - → CILoop when exit predicate met and ready PR already exists
 * (predicate evaluation is separate; this table only encodes legal edges)
 */
const ALLOWED: ReadonlyMap<RunPhase, ReadonlySet<RunPhase>> = new Map<
  RunPhase,
  ReadonlySet<RunPhase>
>([
  ["Inception", new Set<RunPhase>(["Planning", "Cancelled", "Failed"])],
  [
    "Planning",
    new Set<RunPhase>([
      "Planning",
      "PlanConsensus",
      "Cancelled",
      "Failed",
    ]),
  ],
  [
    "PlanConsensus",
    new Set<RunPhase>(["Implementing", "Cancelled", "Failed"]),
  ],
  [
    "Implementing",
    new Set<RunPhase>(["PrePR", "CILoop", "Cancelled", "Failed"]),
  ],
  ["PrePR", new Set<RunPhase>(["PROpen", "CILoop", "Cancelled", "Failed"])],
  ["PROpen", new Set<RunPhase>(["CILoop", "Cancelled", "Failed"])],
  [
    "CILoop",
    new Set<RunPhase>(["Implementing", "MergeReady", "Cancelled", "Failed"]),
  ],
  [
    "MergeReady",
    new Set<RunPhase>(["Merged", "Implementing", "Cancelled", "Failed"]),
  ],
  ["Merged", new Set<RunPhase>()],
  ["Cancelled", new Set<RunPhase>()],
  ["Failed", new Set<RunPhase>()],
]);

const TERMINALS: ReadonlySet<RunPhase> = new Set([
  "Merged",
  "Cancelled",
  "Failed",
]);

export function isTerminalPhase(phase: RunPhase): boolean {
  return TERMINALS.has(phase);
}

/** True if `from → to` is a legal edge (same-phase is allowed only when listed). */
export function canTransitionRunPhase(from: RunPhase, to: RunPhase): boolean {
  return ALLOWED.get(from)?.has(to) ?? false;
}

export function allowedRunTransitions(from: RunPhase): readonly RunPhase[] {
  return [...(ALLOWED.get(from) ?? [])];
}

export interface TransitionRunOptions {
  /** ISO-8601; defaults to now */
  updated_at?: string;
  cancelled_reason?: string;
  failed_reason?: string;
}

/**
 * Apply a run-phase transition (pure; returns a new Run).
 * Throws RunFsmError on illegal edges.
 */
export function transitionRunPhase(
  run: Run,
  to: RunPhase,
  options: TransitionRunOptions = {},
): Run {
  if (!canTransitionRunPhase(run.phase, to)) {
    throw new RunFsmError(
      isTerminalPhase(run.phase) ? "terminal" : "invalid_transition",
      `Cannot transition run ${run.id} from ${run.phase} to ${to}`,
    );
  }

  const next: Run = {
    ...run,
    phase: to,
    updated_at: options.updated_at ?? new Date().toISOString(),
  };

  if (to === "Cancelled" && options.cancelled_reason !== undefined) {
    next.cancelled_reason = options.cancelled_reason;
  }
  if (to === "Failed" && options.failed_reason !== undefined) {
    next.failed_reason = options.failed_reason;
  }

  return next;
}

/** True when `pr_ref` tracks a non-draft ready PR (Implementing → CILoop short-circuit). */
export function hasReadyPr(pr: PrRef | undefined): boolean {
  return pr !== undefined && pr.state === "ready";
}

/**
 * After Implementing exit predicate holds, choose the next phase:
 * - ready PR exists → CILoop (skip PrePR/PROpen)
 * - otherwise → PrePR
 */
export function nextPhaseAfterImplementingExit(
  pr: PrRef | undefined,
): "PrePR" | "CILoop" {
  return hasReadyPr(pr) ? "CILoop" : "PrePR";
}
