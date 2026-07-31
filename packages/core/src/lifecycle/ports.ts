/**
 * Injectable forge GitHub ports for post-Implementing lifecycle.
 * Core never imports @lazyorch/forge — daemon binds real / fake clients.
 */

import type { PrRef } from "../types/run.js";

export type MergeMethod = "squash" | "merge" | "rebase";

export interface EnsureReadyPrPortRequest {
  run_id: string;
  head_branch: string;
  base_branch: string;
  title: string;
  body?: string;
  /** From run.pr_ref.number when set. */
  existing_pr_number?: number;
  owner?: string;
  repo?: string;
}

export interface EnsureReadyPrPortResult {
  pr_ref: PrRef;
  action: "created" | "undrafted" | "already_ready" | "found_existing";
}

export interface PollChecksPortRequest {
  run_id: string;
  /** Branch or sha (prefer pr head_sha / feature tip). */
  ref: string;
  pr_number?: number;
  required_checks: readonly string[];
  owner?: string;
  repo?: string;
}

export interface PollChecksPortResult {
  required_green: boolean;
  required_failed: boolean;
  pending: boolean;
  failed_checks: string[];
  pending_checks: string[];
  head_sha?: string;
}

export interface MergePrPortRequest {
  run_id: string;
  pr_number: number;
  method: MergeMethod;
  owner?: string;
  repo?: string;
}

export interface MergePrPortResult {
  merged: boolean;
  sha?: string;
  message?: string;
}

/**
 * Forge-owned GitHub ops (ensure PR, poll checks, merge).
 * No agent slots; no secrets in agent env.
 */
export interface ForgeGithubPort {
  ensureReadyPr(
    req: EnsureReadyPrPortRequest,
  ): Promise<EnsureReadyPrPortResult>;
  pollChecks(req: PollChecksPortRequest): Promise<PollChecksPortResult>;
  mergePr(req: MergePrPortRequest): Promise<MergePrPortResult>;
}
