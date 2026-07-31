/**
 * Fake ForgeGithubPort for lifecycle unit tests (no network).
 */

import type { PrRef } from "../types/run.js";
import type {
  EnsureReadyPrPortRequest,
  EnsureReadyPrPortResult,
  ForgeGithubPort,
  MergePrPortRequest,
  MergePrPortResult,
  PollChecksPortRequest,
  PollChecksPortResult,
} from "./ports.js";

export class FakeForgeGithub implements ForgeGithubPort {
  readonly ensureCalls: EnsureReadyPrPortRequest[] = [];
  readonly pollCalls: PollChecksPortRequest[] = [];
  readonly mergeCalls: MergePrPortRequest[] = [];

  private pr: PrRef | undefined;
  private nextNumber = 1;
  private pollQueue: PollChecksPortResult[] = [];
  private pollDefault: PollChecksPortResult = {
    required_green: false,
    required_failed: false,
    pending: true,
    failed_checks: [],
    pending_checks: ["ci"],
  };
  private mergeQueue: MergePrPortResult[] = [];

  constructor(options?: {
    pr?: PrRef;
    pollResults?: PollChecksPortResult[];
    pollDefault?: PollChecksPortResult;
    mergeResults?: MergePrPortResult[];
  }) {
    if (options?.pr) this.pr = { ...options.pr };
    if (options?.pollResults) this.pollQueue = [...options.pollResults];
    if (options?.pollDefault) this.pollDefault = { ...options.pollDefault };
    if (options?.mergeResults) this.mergeQueue = [...options.mergeResults];
  }

  setPr(pr: PrRef | undefined): void {
    this.pr = pr ? { ...pr } : undefined;
  }

  enqueuePoll(...results: PollChecksPortResult[]): void {
    this.pollQueue.push(...results);
  }

  enqueueMerge(...results: MergePrPortResult[]): void {
    this.mergeQueue.push(...results);
  }

  async ensureReadyPr(
    req: EnsureReadyPrPortRequest,
  ): Promise<EnsureReadyPrPortResult> {
    this.ensureCalls.push(req);

    if (this.pr?.state === "ready") {
      return { pr_ref: { ...this.pr }, action: "already_ready" };
    }
    if (this.pr?.state === "draft") {
      this.pr = { ...this.pr, state: "ready" };
      return { pr_ref: { ...this.pr }, action: "undrafted" };
    }

    const number = req.existing_pr_number ?? this.nextNumber++;
    this.pr = {
      number,
      state: "ready",
      url: `https://example.test/pr/${number}`,
      head_sha: req.head_branch,
    };
    const action =
      req.existing_pr_number !== undefined ? "undrafted" : "created";
    return { pr_ref: { ...this.pr }, action };
  }

  async pollChecks(req: PollChecksPortRequest): Promise<PollChecksPortResult> {
    this.pollCalls.push(req);
    const next = this.pollQueue.shift();
    if (next) return { ...next };
    return { ...this.pollDefault };
  }

  async mergePr(req: MergePrPortRequest): Promise<MergePrPortResult> {
    this.mergeCalls.push(req);
    const next = this.mergeQueue.shift();
    if (next) {
      if (next.merged && this.pr) {
        this.pr = { ...this.pr, state: "merged" };
      }
      return { ...next };
    }
    if (this.pr) this.pr = { ...this.pr, state: "merged" };
    return { merged: true, sha: "merge_sha" };
  }
}
