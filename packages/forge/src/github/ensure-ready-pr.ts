/**
 * Idempotent ensure_ready_pr(run) (design-lazyorch CI/PR re-entry profile).
 *
 * - create draft if missing, then undraft/mark ready
 * - undraft/mark ready if draft
 * - no-op if ready PR already linked
 * - never open a duplicate PR when pr_ref.number is set and still exists
 */

import type {
  EnsureReadyPrRequest,
  EnsureReadyPrResult,
  GithubPr,
} from "./types.js";

export class EnsureReadyPrError extends Error {
  readonly code:
    | "pr_merged"
    | "pr_closed"
    | "missing_head"
    | "client_error";

  constructor(code: EnsureReadyPrError["code"], message: string) {
    super(message);
    this.name = "EnsureReadyPrError";
    this.code = code;
  }
}

function assertOpenable(pr: GithubPr, context: string): void {
  if (pr.state === "merged") {
    throw new EnsureReadyPrError(
      "pr_merged",
      `${context}: PR #${pr.number} is already merged`,
    );
  }
  if (pr.state === "closed") {
    throw new EnsureReadyPrError(
      "pr_closed",
      `${context}: PR #${pr.number} is closed`,
    );
  }
}

/**
 * Ensure a non-draft (ready) PR exists for the feature head branch.
 * Pure orchestration over {@link GithubClient} — no network itself.
 */
export async function ensureReadyPr(
  req: EnsureReadyPrRequest,
): Promise<EnsureReadyPrResult> {
  const { client, owner, repo, head_branch, base_branch, title } = req;

  if (!head_branch) {
    throw new EnsureReadyPrError(
      "missing_head",
      "ensureReadyPr requires head_branch",
    );
  }

  // 1. Prefer linked pr_ref.number
  if (req.existing_pr_number !== undefined) {
    const linked = await client.getPr(owner, repo, req.existing_pr_number);
    if (linked) {
      assertOpenable(linked, "ensureReadyPr(linked)");
      if (linked.state === "ready") {
        return { pr: linked, action: "already_ready" };
      }
      // draft → ready
      const ready = await client.markReady(owner, repo, linked.number);
      return { pr: ready, action: "undrafted" };
    }
    // Linked number missing on forge — fall through to head search / create
  }

  // 2. Search by head branch (open draft|ready only)
  const found = await client.findPrByHead(owner, repo, head_branch);
  if (found) {
    assertOpenable(found, "ensureReadyPr(find)");
    if (found.state === "ready") {
      return { pr: found, action: "found_existing" };
    }
    const ready = await client.markReady(owner, repo, found.number);
    return { pr: ready, action: "undrafted" };
  }

  // 3. Create draft then mark ready (idempotent ready PR for CILoop)
  const created = await client.createPr({
    owner,
    repo,
    head_branch,
    base_branch,
    title,
    ...(req.body !== undefined ? { body: req.body } : {}),
    draft: true,
  });
  const ready = await client.markReady(owner, repo, created.number);
  return { pr: ready, action: "created" };
}

/**
 * Optional: ensure a **draft** PR exists (first successful integration path).
 * Does not undraft. No-op if any open PR already tracks head.
 */
export async function ensureDraftPr(req: {
  owner: string;
  repo: string;
  head_branch: string;
  base_branch: string;
  title: string;
  body?: string;
  existing_pr_number?: number;
  client: EnsureReadyPrRequest["client"];
}): Promise<{ pr: GithubPr; action: "created" | "already_exists" }> {
  const { client, owner, repo, head_branch } = req;

  if (req.existing_pr_number !== undefined) {
    const linked = await client.getPr(owner, repo, req.existing_pr_number);
    if (linked && (linked.state === "draft" || linked.state === "ready")) {
      return { pr: linked, action: "already_exists" };
    }
  }

  const found = await client.findPrByHead(owner, repo, head_branch);
  if (found) {
    return { pr: found, action: "already_exists" };
  }

  const created = await client.createPr({
    owner,
    repo,
    head_branch,
    base_branch: req.base_branch,
    title: req.title,
    ...(req.body !== undefined ? { body: req.body } : {}),
    draft: true,
  });
  return { pr: created, action: "created" };
}
