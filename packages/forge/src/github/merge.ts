/**
 * Merge helpers (forge-owned; used after merge gate approve).
 */

import type {
  GithubClient,
  MergeMethod,
  MergePrInput,
  MergePrResult,
} from "./types.js";

export class MergePrError extends Error {
  readonly code: "not_ready" | "merge_failed" | "not_found";

  constructor(code: MergePrError["code"], message: string) {
    super(message);
    this.name = "MergePrError";
    this.code = code;
  }
}

export interface MergeReadyPrRequest {
  owner: string;
  repo: string;
  number: number;
  method: MergeMethod;
  client: GithubClient;
  commit_title?: string;
  commit_message?: string;
}

/**
 * Merge a ready PR. Throws if PR missing or not ready.
 * Returns forge merge result (merged: false is also thrown as merge_failed).
 */
export async function mergeReadyPr(
  req: MergeReadyPrRequest,
): Promise<MergePrResult & { number: number }> {
  const pr = await req.client.getPr(req.owner, req.repo, req.number);
  if (!pr) {
    throw new MergePrError(
      "not_found",
      `mergeReadyPr: PR #${req.number} not found`,
    );
  }
  if (pr.state === "merged") {
    return {
      merged: true,
      ...(pr.head_sha !== undefined ? { sha: pr.head_sha } : {}),
      message: "already merged",
      number: pr.number,
    };
  }
  if (pr.state !== "ready") {
    throw new MergePrError(
      "not_ready",
      `mergeReadyPr: PR #${req.number} is ${pr.state}, expected ready`,
    );
  }

  const input: MergePrInput = {
    owner: req.owner,
    repo: req.repo,
    number: req.number,
    method: req.method,
    ...(req.commit_title !== undefined
      ? { commit_title: req.commit_title }
      : {}),
    ...(req.commit_message !== undefined
      ? { commit_message: req.commit_message }
      : {}),
  };
  const result = await req.client.mergePr(input);
  if (!result.merged) {
    throw new MergePrError(
      "merge_failed",
      result.message ?? `merge of PR #${req.number} failed`,
    );
  }
  return { ...result, number: req.number };
}
