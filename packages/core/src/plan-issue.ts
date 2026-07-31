import type { IssueStatus, PlanIssue } from "./types/plan.js";

export class PlanIssueError extends Error {
  readonly code: "invalid_transition" | "response_required";

  constructor(code: PlanIssueError["code"], message: string) {
    super(message);
    this.name = "PlanIssueError";
    this.code = code;
  }
}

/**
 * Allowed PlanIssue status transitions (planning consensus, not FSM engine).
 *
 * open ⇄ needs-user-input
 * open → addressed | wontfix (response required)
 * needs-user-input → addressed | wontfix (response required)
 * addressed | wontfix → open (re-open by reviewer)
 */
const ALLOWED: ReadonlyMap<IssueStatus, ReadonlySet<IssueStatus>> = new Map<
  IssueStatus,
  ReadonlySet<IssueStatus>
>([
  ["open", new Set<IssueStatus>(["addressed", "wontfix", "needs-user-input"])],
  ["needs-user-input", new Set<IssueStatus>(["open", "addressed", "wontfix"])],
  ["addressed", new Set<IssueStatus>(["open"])],
  ["wontfix", new Set<IssueStatus>(["open"])],
]);

export function canTransitionIssueStatus(
  from: IssueStatus,
  to: IssueStatus,
): boolean {
  if (from === to) return true;
  return ALLOWED.get(from)?.has(to) ?? false;
}

export interface TransitionIssueOptions {
  /** Required when moving to addressed | wontfix */
  response?: string;
  /** ISO-8601; defaults to now */
  updated_at?: string;
}

/**
 * Apply a status transition on a PlanIssue (pure; returns a new object).
 * Throws PlanIssueError on illegal edges or missing response.
 */
export function transitionPlanIssue(
  issue: PlanIssue,
  to: IssueStatus,
  options: TransitionIssueOptions = {},
): PlanIssue {
  if (!canTransitionIssueStatus(issue.status, to)) {
    throw new PlanIssueError(
      "invalid_transition",
      `Cannot transition PlanIssue ${issue.id} from ${issue.status} to ${to}`,
    );
  }

  const needsResponse = to === "addressed" || to === "wontfix";
  if (needsResponse) {
    const response = options.response ?? issue.response;
    if (response === undefined || response.trim() === "") {
      throw new PlanIssueError(
        "response_required",
        `response is required when status becomes ${to}`,
      );
    }
    const next: PlanIssue = {
      ...issue,
      status: to,
      response,
      updated_at: options.updated_at ?? new Date().toISOString(),
    };
    return next;
  }

  const next: PlanIssue = {
    ...issue,
    status: to,
    updated_at: options.updated_at ?? new Date().toISOString(),
  };
  return next;
}

/** Count issues still blocking freeze (open or needs-user-input). */
export function countOpenIssues(issues: readonly PlanIssue[]): number {
  return issues.filter(
    (i) => i.status === "open" || i.status === "needs-user-input",
  ).length;
}
