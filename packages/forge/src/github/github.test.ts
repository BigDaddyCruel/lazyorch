import { describe, expect, it } from "vitest";
import {
  evaluateChecks,
  ensureDraftPr,
  ensureReadyPr,
  EnsureReadyPrError,
  FakeGithubClient,
  mergeReadyPr,
  MergePrError,
  pollCheckStatus,
} from "./index.js";

const OWNER = "acme";
const REPO = "app";
const HEAD = "lazyorch/run_x/feature";
const BASE = "main";

describe("FakeGithubClient recording", () => {
  it("records calls without network", async () => {
    const client = new FakeGithubClient();
    await client.createPr({
      owner: OWNER,
      repo: REPO,
      head_branch: HEAD,
      base_branch: BASE,
      title: "feat",
      draft: true,
    });
    await client.markReady(OWNER, REPO, 1);
    expect(client.calls.map((c) => c.op)).toEqual(["createPr", "markReady"]);
    expect(client.recording()[0]?.op).toBe("createPr");
  });
});

describe("ensureReadyPr", () => {
  it("creates draft then marks ready when missing", async () => {
    const client = new FakeGithubClient();
    const result = await ensureReadyPr({
      owner: OWNER,
      repo: REPO,
      head_branch: HEAD,
      base_branch: BASE,
      title: "Implement idea",
      client,
    });
    expect(result.action).toBe("created");
    expect(result.pr.state).toBe("ready");
    expect(result.pr.number).toBe(1);
    expect(client.calls.map((c) => c.op)).toEqual([
      "findPrByHead",
      "createPr",
      "markReady",
    ]);
  });

  it("no-ops when linked PR already ready", async () => {
    const client = new FakeGithubClient();
    client.seedPr(OWNER, REPO, {
      number: 7,
      url: "https://github.com/acme/app/pull/7",
      state: "ready",
      head_branch: HEAD,
      base_branch: BASE,
      title: "t",
      head_sha: "abc",
    });
    const result = await ensureReadyPr({
      owner: OWNER,
      repo: REPO,
      head_branch: HEAD,
      base_branch: BASE,
      title: "t",
      existing_pr_number: 7,
      client,
    });
    expect(result.action).toBe("already_ready");
    expect(result.pr.number).toBe(7);
    expect(client.calls.map((c) => c.op)).toEqual(["getPr"]);
  });

  it("undrafts linked draft PR", async () => {
    const client = new FakeGithubClient();
    client.seedPr(OWNER, REPO, {
      number: 3,
      url: "u",
      state: "draft",
      head_branch: HEAD,
      base_branch: BASE,
      title: "t",
    });
    const result = await ensureReadyPr({
      owner: OWNER,
      repo: REPO,
      head_branch: HEAD,
      base_branch: BASE,
      title: "t",
      existing_pr_number: 3,
      client,
    });
    expect(result.action).toBe("undrafted");
    expect(result.pr.state).toBe("ready");
  });

  it("finds existing ready PR by head without duplicating", async () => {
    const client = new FakeGithubClient();
    client.seedPr(OWNER, REPO, {
      number: 9,
      url: "u",
      state: "ready",
      head_branch: HEAD,
      base_branch: BASE,
      title: "t",
    });
    const result = await ensureReadyPr({
      owner: OWNER,
      repo: REPO,
      head_branch: HEAD,
      base_branch: BASE,
      title: "t",
      client,
    });
    expect(result.action).toBe("found_existing");
    expect(result.pr.number).toBe(9);
    // second call still no create
    const again = await ensureReadyPr({
      owner: OWNER,
      repo: REPO,
      head_branch: HEAD,
      base_branch: BASE,
      title: "t",
      existing_pr_number: 9,
      client,
    });
    expect(again.action).toBe("already_ready");
    expect(client.calls.filter((c) => c.op === "createPr")).toHaveLength(0);
  });

  it("rejects merged linked PR", async () => {
    const client = new FakeGithubClient();
    client.seedPr(OWNER, REPO, {
      number: 1,
      url: "u",
      state: "merged",
      head_branch: HEAD,
      base_branch: BASE,
      title: "t",
    });
    await expect(
      ensureReadyPr({
        owner: OWNER,
        repo: REPO,
        head_branch: HEAD,
        base_branch: BASE,
        title: "t",
        existing_pr_number: 1,
        client,
      }),
    ).rejects.toMatchObject({ code: "pr_merged" } satisfies Partial<EnsureReadyPrError>);
  });
});

describe("ensureDraftPr", () => {
  it("creates draft once", async () => {
    const client = new FakeGithubClient();
    const a = await ensureDraftPr({
      owner: OWNER,
      repo: REPO,
      head_branch: HEAD,
      base_branch: BASE,
      title: "draft",
      client,
    });
    expect(a.action).toBe("created");
    expect(a.pr.state).toBe("draft");
    const b = await ensureDraftPr({
      owner: OWNER,
      repo: REPO,
      head_branch: HEAD,
      base_branch: BASE,
      title: "draft",
      existing_pr_number: a.pr.number,
      client,
    });
    expect(b.action).toBe("already_exists");
  });
});

describe("evaluateChecks / pollCheckStatus", () => {
  it("empty required never greens (must configure forge.required_checks)", () => {
    const empty = evaluateChecks([], []);
    expect(empty.pending).toBe(true);
    expect(empty.required_green).toBe(false);
    expect(empty.pending_checks).toContain("*configure_required_checks");

    // All reported checks ok still pending without named required list
    const allOk = evaluateChecks(
      [{ name: "ci", status: "completed", conclusion: "success" }],
      [],
    );
    expect(allOk.required_green).toBe(false);
    expect(allOk.pending).toBe(true);
  });

  it("empty required still fails on reported failure", () => {
    const r = evaluateChecks(
      [{ name: "ci", status: "completed", conclusion: "failure" }],
      [],
    );
    expect(r.required_failed).toBe(true);
    expect(r.required_green).toBe(false);
    expect(r.failed_checks).toEqual(["ci"]);
  });

  it("required names missing ⇒ pending", () => {
    const r = evaluateChecks(
      [{ name: "lint", status: "completed", conclusion: "success" }],
      ["lint", "test"],
    );
    expect(r.pending).toBe(true);
    expect(r.pending_checks).toContain("test");
  });

  it("required green when all success", () => {
    const r = evaluateChecks(
      [
        { name: "lint", status: "completed", conclusion: "success" },
        { name: "test", status: "completed", conclusion: "success" },
      ],
      ["lint", "test"],
    );
    expect(r.required_green).toBe(true);
    expect(r.required_failed).toBe(false);
    expect(r.pending).toBe(false);
  });

  it("required failed on failure conclusion", () => {
    const r = evaluateChecks(
      [
        { name: "lint", status: "completed", conclusion: "success" },
        { name: "test", status: "completed", conclusion: "failure" },
      ],
      ["lint", "test"],
    );
    expect(r.required_failed).toBe(true);
    expect(r.failed_checks).toEqual(["test"]);
    expect(r.required_green).toBe(false);
  });

  it("pollCheckStatus uses client checks", async () => {
    const client = new FakeGithubClient({
      checks_by_ref: {
        HEAD: [
          { name: "ci", status: "completed", conclusion: "success" },
        ],
      },
    });
    // seed under exact ref used
    client.setChecks("abc123", [
      { name: "ci", status: "completed", conclusion: "success" },
    ]);
    const r = await pollCheckStatus({
      owner: OWNER,
      repo: REPO,
      ref: "abc123",
      required_checks: ["ci"],
      client,
    });
    expect(r.required_green).toBe(true);
    expect(r.checks).toHaveLength(1);
  });
});

describe("mergeReadyPr", () => {
  it("merges ready PR", async () => {
    const client = new FakeGithubClient();
    client.seedPr(OWNER, REPO, {
      number: 2,
      url: "u",
      state: "ready",
      head_branch: HEAD,
      base_branch: BASE,
      title: "t",
      head_sha: "tip",
    });
    const r = await mergeReadyPr({
      owner: OWNER,
      repo: REPO,
      number: 2,
      method: "squash",
      client,
    });
    expect(r.merged).toBe(true);
    expect(r.sha).toBe("tip");
    const pr = await client.getPr(OWNER, REPO, 2);
    expect(pr?.state).toBe("merged");
  });

  it("rejects draft", async () => {
    const client = new FakeGithubClient();
    client.seedPr(OWNER, REPO, {
      number: 2,
      url: "u",
      state: "draft",
      head_branch: HEAD,
      base_branch: BASE,
      title: "t",
    });
    await expect(
      mergeReadyPr({
        owner: OWNER,
        repo: REPO,
        number: 2,
        method: "squash",
        client,
      }),
    ).rejects.toMatchObject({ code: "not_ready" } satisfies Partial<MergePrError>);
  });
});
