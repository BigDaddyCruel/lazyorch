/**
 * PrePR / PROpen phase helpers — ensure ready PR then hand off to CILoop.
 */

import {
  hasReadyPr,
  transitionRunPhase,
} from "../orchestrator/run-fsm.js";
import type { PrRef, Run } from "../types/run.js";
import type {
  EnsureReadyPrPortResult,
  ForgeGithubPort,
} from "./ports.js";

export interface PrePrConfig {
  base_branch?: string;
  pr_title?: string;
  pr_body?: string;
  owner?: string;
  repo?: string;
}

export interface RunPrePrResult {
  run: Run;
  ensure?: EnsureReadyPrPortResult;
  /** Transitions taken this step (for metrics / zero-duration no-ops). */
  transitions: Array<{ from: string; to: string; noop?: boolean }>;
}

function defaultTitle(run: Run): string {
  const idea = run.idea.trim();
  if (idea.length <= 72) return idea || `LazyOrch ${run.id}`;
  return `${idea.slice(0, 69)}...`;
}

/**
 * Pure: after ensure result, attach pr_ref and choose next phase.
 * - already_ready / found_existing with ready → may skip PROpen → CILoop
 * - created / undrafted → PROpen then caller advances to CILoop
 */
export function applyEnsureReadyResult(
  run: Run,
  ensure: EnsureReadyPrPortResult,
  opts?: { updated_at?: string; skip_propen?: boolean },
): { run: Run; next_phase: "PROpen" | "CILoop" } {
  if (run.phase !== "PrePR" && run.phase !== "PROpen") {
    throw new Error(
      `applyEnsureReadyResult requires PrePR|PROpen, got ${run.phase}`,
    );
  }
  const ts = opts?.updated_at ?? new Date().toISOString();
  const withPr: Run = {
    ...run,
    pr_ref: ensure.pr_ref,
    updated_at: ts,
  };

  // Design: PrePR → CILoop when ready PR already ensured; else PrePR → PROpen
  if (
    ensure.action === "already_ready" ||
    ensure.action === "found_existing" ||
    opts?.skip_propen === true
  ) {
    return { run: withPr, next_phase: "CILoop" };
  }
  return { run: withPr, next_phase: "PROpen" };
}

/**
 * PrePR tick: ensure ready PR (idempotent), transition to PROpen or CILoop.
 * If ready PR already on run, short-circuit to CILoop (no forge call required).
 */
export async function runPrePrPhase(
  run: Run,
  forge: ForgeGithubPort,
  config: PrePrConfig = {},
  opts?: { now?: () => string },
): Promise<RunPrePrResult> {
  if (run.phase !== "PrePR") {
    throw new Error(`runPrePrPhase requires PrePR, got ${run.phase}`);
  }

  const transitions: RunPrePrResult["transitions"] = [];
  const ts = opts?.now?.() ?? new Date().toISOString();

  // Short-circuit: ready PR already linked
  if (hasReadyPr(run.pr_ref)) {
    const next = transitionRunPhase(run, "CILoop", { updated_at: ts });
    transitions.push({ from: "PrePR", to: "CILoop", noop: true });
    return { run: next, transitions };
  }

  const head =
    run.feature_branch ??
    (run.id ? `lazyorch/${run.id}/feature` : undefined);
  if (!head) {
    throw new Error("runPrePrPhase: feature_branch missing");
  }

  const ensure = await forge.ensureReadyPr({
    run_id: run.id,
    head_branch: head,
    base_branch: config.base_branch ?? "main",
    title: config.pr_title ?? defaultTitle(run),
    ...(config.pr_body !== undefined ? { body: config.pr_body } : {}),
    ...(run.pr_ref?.number !== undefined
      ? { existing_pr_number: run.pr_ref.number }
      : {}),
    ...(config.owner !== undefined ? { owner: config.owner } : {}),
    ...(config.repo !== undefined ? { repo: config.repo } : {}),
  });

  const applied = applyEnsureReadyResult(run, ensure, { updated_at: ts });
  let next = applied.run;
  if (next.phase === "PrePR") {
    next = transitionRunPhase(next, applied.next_phase, { updated_at: ts });
    transitions.push({ from: "PrePR", to: applied.next_phase });
  }

  return { run: next, ensure, transitions };
}

/**
 * PROpen tick: hand off to CILoop (instantaneous after ensure).
 */
export function runPrOpenPhase(
  run: Run,
  opts?: { now?: () => string },
): RunPrePrResult {
  if (run.phase !== "PROpen") {
    throw new Error(`runPrOpenPhase requires PROpen, got ${run.phase}`);
  }
  const ts = opts?.now?.() ?? new Date().toISOString();
  if (!hasReadyPr(run.pr_ref) && run.pr_ref?.state !== "ready") {
    // still allow transition if pr_ref ready-ish
    if (run.pr_ref && run.pr_ref.state === "draft") {
      throw new Error("runPrOpenPhase: pr_ref still draft; re-run PrePR");
    }
  }
  const next = transitionRunPhase(run, "CILoop", { updated_at: ts });
  return {
    run: next,
    transitions: [{ from: "PROpen", to: "CILoop" }],
  };
}

/** Map forge PrRef onto Run (helper for daemon binding). */
export function withPrRef(run: Run, pr_ref: PrRef, now?: () => string): Run {
  return {
    ...run,
    pr_ref,
    updated_at: now?.() ?? new Date().toISOString(),
  };
}
