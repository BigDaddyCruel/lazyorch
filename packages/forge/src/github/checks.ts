/**
 * Check status poll helpers for CILoop.
 */

import type {
  CheckConclusion,
  CheckRun,
  PollChecksRequest,
  PollChecksResult,
} from "./types.js";

const FAIL_CONCLUSIONS: ReadonlySet<CheckConclusion> = new Set([
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
]);

const OK_CONCLUSIONS: ReadonlySet<CheckConclusion> = new Set([
  "success",
  "neutral",
  "skipped",
]);

export function isCheckFailed(check: CheckRun): boolean {
  if (check.status !== "completed") return false;
  return FAIL_CONCLUSIONS.has(check.conclusion ?? null);
}

export function isCheckOk(check: CheckRun): boolean {
  if (check.status !== "completed") return false;
  return OK_CONCLUSIONS.has(check.conclusion ?? null);
}

export function isCheckPending(check: CheckRun): boolean {
  return check.status === "queued" || check.status === "in_progress";
}

/**
 * Evaluate required checks against a check-run list (pure).
 *
 * - `required_checks` empty: green only when there is ≥1 check and all completed ok;
 *   zero checks ⇒ pending (CI not reported yet).
 * - named required: each name must appear and be ok; missing ⇒ pending;
 *   any fail ⇒ required_failed.
 */
export function evaluateChecks(
  checks: readonly CheckRun[],
  required_checks: readonly string[],
): Omit<PollChecksResult, "head_ref" | "checks"> {
  const byName = new Map<string, CheckRun>();
  for (const c of checks) {
    // Prefer latest-ish: last write wins if duplicates
    byName.set(c.name, c);
  }

  const failed_checks: string[] = [];
  const pending_checks: string[] = [];

  if (required_checks.length === 0) {
    if (checks.length === 0) {
      return {
        required_green: false,
        required_failed: false,
        pending: true,
        failed_checks: [],
        pending_checks: ["*"],
      };
    }
    for (const c of checks) {
      if (isCheckFailed(c)) failed_checks.push(c.name);
      else if (isCheckPending(c) || !isCheckOk(c)) pending_checks.push(c.name);
    }
    return {
      required_green: failed_checks.length === 0 && pending_checks.length === 0,
      required_failed: failed_checks.length > 0,
      pending: pending_checks.length > 0 && failed_checks.length === 0,
      failed_checks,
      pending_checks,
    };
  }

  for (const name of required_checks) {
    const c = byName.get(name);
    if (!c) {
      pending_checks.push(name);
      continue;
    }
    if (isCheckFailed(c)) failed_checks.push(name);
    else if (isCheckPending(c) || !isCheckOk(c)) pending_checks.push(name);
  }

  return {
    required_green: failed_checks.length === 0 && pending_checks.length === 0,
    required_failed: failed_checks.length > 0,
    pending: pending_checks.length > 0 && failed_checks.length === 0,
    failed_checks,
    pending_checks,
  };
}

/**
 * Poll forge checks for a ref and evaluate against required names.
 */
export async function pollCheckStatus(
  req: PollChecksRequest,
): Promise<PollChecksResult> {
  const checks = await req.client.getChecks(req.owner, req.repo, req.ref);
  const evaluated = evaluateChecks(checks, req.required_checks);
  return {
    head_ref: req.ref,
    checks,
    ...evaluated,
  };
}
