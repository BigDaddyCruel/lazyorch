/**
 * Fake / record GitHub client for CI tests (no live network).
 *
 * - Script responses via in-memory PR store + check maps
 * - Optional `recording` log of every call for assertions / replay fixtures
 */

import type {
  CheckRun,
  CreatePrInput,
  GithubClient,
  GithubPr,
  MergePrInput,
  MergePrResult,
} from "./types.js";

export type FakeGithubCall =
  | {
      op: "findPrByHead";
      owner: string;
      repo: string;
      head_branch: string;
      result: GithubPr | null;
    }
  | {
      op: "getPr";
      owner: string;
      repo: string;
      number: number;
      result: GithubPr | null;
    }
  | {
      op: "createPr";
      input: CreatePrInput;
      result: GithubPr;
    }
  | {
      op: "markReady";
      owner: string;
      repo: string;
      number: number;
      result: GithubPr;
    }
  | {
      op: "getChecks";
      owner: string;
      repo: string;
      ref: string;
      result: CheckRun[];
    }
  | {
      op: "mergePr";
      input: MergePrInput;
      result: MergePrResult;
    };

export interface FakeGithubClientOptions {
  /** Seed PRs keyed by number. */
  prs?: GithubPr[];
  /** Checks keyed by ref (branch or sha). */
  checks_by_ref?: Record<string, CheckRun[]>;
  /** Starting PR number sequence (default 1). */
  next_pr_number?: number;
  /** Base URL for synthetic PR urls. */
  html_base?: string;
}

function key(owner: string, repo: string): string {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

/**
 * In-memory GitHub client. No network. Records every call on {@link calls}.
 */
export class FakeGithubClient implements GithubClient {
  readonly calls: FakeGithubCall[] = [];
  private readonly prs = new Map<string, Map<number, GithubPr>>();
  private readonly checks = new Map<string, CheckRun[]>();
  private nextNumber: number;
  private readonly htmlBase: string;

  constructor(options: FakeGithubClientOptions = {}) {
    this.nextNumber = options.next_pr_number ?? 1;
    this.htmlBase = options.html_base ?? "https://github.com";
    if (options.prs) {
      for (const pr of options.prs) {
        // owner/repo not on GithubPr — use synthetic key from url or default
        this.seedPr("o", "r", pr);
      }
    }
    if (options.checks_by_ref) {
      for (const [ref, runs] of Object.entries(options.checks_by_ref)) {
        this.checks.set(ref, runs.map((c) => ({ ...c })));
      }
    }
  }

  /** Seed / replace a PR under owner/repo. */
  seedPr(owner: string, repo: string, pr: GithubPr): void {
    const k = key(owner, repo);
    let map = this.prs.get(k);
    if (!map) {
      map = new Map();
      this.prs.set(k, map);
    }
    map.set(pr.number, { ...pr });
    if (pr.number >= this.nextNumber) this.nextNumber = pr.number + 1;
  }

  /** Set check runs for a ref (branch or sha). */
  setChecks(ref: string, checks: CheckRun[]): void {
    this.checks.set(ref, checks.map((c) => ({ ...c })));
  }

  clearCalls(): void {
    this.calls.length = 0;
  }

  /** Serialized call log for fixtures. */
  recording(): FakeGithubCall[] {
    return this.calls.map((c) => structuredClone(c));
  }

  private repoMap(owner: string, repo: string): Map<number, GithubPr> {
    const k = key(owner, repo);
    let map = this.prs.get(k);
    if (!map) {
      map = new Map();
      this.prs.set(k, map);
    }
    return map;
  }

  async findPrByHead(
    owner: string,
    repo: string,
    head_branch: string,
  ): Promise<GithubPr | null> {
    const map = this.repoMap(owner, repo);
    let found: GithubPr | null = null;
    for (const pr of map.values()) {
      if (
        pr.head_branch === head_branch &&
        (pr.state === "draft" || pr.state === "ready")
      ) {
        found = { ...pr };
        break;
      }
    }
    this.calls.push({
      op: "findPrByHead",
      owner,
      repo,
      head_branch,
      result: found,
    });
    return found;
  }

  async getPr(
    owner: string,
    repo: string,
    number: number,
  ): Promise<GithubPr | null> {
    const pr = this.repoMap(owner, repo).get(number);
    const result = pr ? { ...pr } : null;
    this.calls.push({ op: "getPr", owner, repo, number, result });
    return result;
  }

  async createPr(input: CreatePrInput): Promise<GithubPr> {
    const number = this.nextNumber++;
    const draft = input.draft !== false;
    const pr: GithubPr = {
      number,
      url: `${this.htmlBase}/${input.owner}/${input.repo}/pull/${number}`,
      state: draft ? "draft" : "ready",
      head_branch: input.head_branch,
      base_branch: input.base_branch,
      title: input.title,
      ...(input.body !== undefined ? { body: input.body } : {}),
      head_sha: `sha_pr_${number}`,
    };
    this.repoMap(input.owner, input.repo).set(number, pr);
    const result = { ...pr };
    this.calls.push({ op: "createPr", input: { ...input }, result });
    return result;
  }

  async markReady(
    owner: string,
    repo: string,
    number: number,
  ): Promise<GithubPr> {
    const map = this.repoMap(owner, repo);
    const existing = map.get(number);
    if (!existing) {
      throw new Error(`FakeGithubClient.markReady: PR #${number} not found`);
    }
    if (existing.state === "merged" || existing.state === "closed") {
      throw new Error(
        `FakeGithubClient.markReady: PR #${number} is ${existing.state}`,
      );
    }
    const next: GithubPr = { ...existing, state: "ready" };
    map.set(number, next);
    const result = { ...next };
    this.calls.push({ op: "markReady", owner, repo, number, result });
    return result;
  }

  async getChecks(
    owner: string,
    repo: string,
    ref: string,
  ): Promise<CheckRun[]> {
    const result = (this.checks.get(ref) ?? []).map((c) => ({ ...c }));
    this.calls.push({ op: "getChecks", owner, repo, ref, result });
    return result;
  }

  async mergePr(input: MergePrInput): Promise<MergePrResult> {
    const map = this.repoMap(input.owner, input.repo);
    const existing = map.get(input.number);
    if (!existing) {
      const result: MergePrResult = {
        merged: false,
        message: `PR #${input.number} not found`,
      };
      this.calls.push({ op: "mergePr", input: { ...input }, result });
      return result;
    }
    if (existing.state !== "ready") {
      const result: MergePrResult = {
        merged: false,
        message: `PR #${input.number} state is ${existing.state}, expected ready`,
      };
      this.calls.push({ op: "mergePr", input: { ...input }, result });
      return result;
    }
    const sha = existing.head_sha ?? `merged_${input.number}`;
    map.set(input.number, { ...existing, state: "merged" });
    const result: MergePrResult = { merged: true, sha };
    this.calls.push({ op: "mergePr", input: { ...input }, result });
    return result;
  }
}
