import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { SCHEMA_VERSION, StateStore, type Gate } from "@lazyorch/core";
import { runGate } from "./gate.js";
import { EXIT } from "../exit-codes.js";

const temps: string[] = [];

async function tempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lazyorch-cli-gate-"));
  temps.push(dir);
  await mkdir(join(dir, ".lazyorch"), { recursive: true });
  await writeFile(
    join(dir, ".lazyorch", "project.json"),
    JSON.stringify({
      schema_version: SCHEMA_VERSION,
      id: "proj_gate",
      repo_root: dir,
      name: "gate",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    }),
    "utf8",
  );
  return dir;
}

function capture(): {
  stdout: NodeJS.WritableStream & { text: string };
  stderr: NodeJS.WritableStream & { text: string };
} {
  const out = { text: "", write(s: string) { this.text += s; return true; } };
  const err = { text: "", write(s: string) { this.text += s; return true; } };
  return {
    stdout: out as NodeJS.WritableStream & { text: string },
    stderr: err as NodeJS.WritableStream & { text: string },
  };
}

afterEach(async () => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("runGate", () => {
  it("lists pending gates and --check exits 3", async () => {
    const repo = await tempRepo();
    const store = new StateStore(join(repo, ".lazyorch"));
    const runId = "run_gate1aaaaaaaaaaaaaaaaaaaa";
    await store.writeRun({
      schema_version: SCHEMA_VERSION,
      id: runId,
      project_id: "proj_gate",
      phase: "Implementing",
      idea: "g",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    const gate: Gate = {
      id: "gate_listaaaaaaaaaaaaaaaaaaaaa",
      type: "human_intervention",
      run_id: runId,
      status: "pending",
      created_at: "2026-01-01T00:00:00.000Z",
      payload: { reason: "stall" },
    };
    await store.writeGates(runId, [gate]);

    const streams = capture();
    const listed = await runGate({
      action: "list",
      repo,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(listed.exitCode).toBe(EXIT.OK);
    expect(listed.gates).toHaveLength(1);

    streams.stdout.text = "";
    const checked = await runGate({
      action: "list",
      check: true,
      repo,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(checked.exitCode).toBe(EXIT.GATE);
  });

  it("approves plan_approve and advances run", async () => {
    const repo = await tempRepo();
    const store = new StateStore(join(repo, ".lazyorch"));
    const runId = "run_gate2aaaaaaaaaaaaaaaaaaaa";
    await store.writeRun({
      schema_version: SCHEMA_VERSION,
      id: runId,
      project_id: "proj_gate",
      phase: "PlanConsensus",
      idea: "plan",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    const gate: Gate = {
      id: "gate_approveaaaaaaaaaaaaaaaaaa",
      type: "plan_approve",
      run_id: runId,
      status: "pending",
      created_at: "2026-01-01T00:00:00.000Z",
      payload: { plan_id: "plan_x" },
    };
    await store.writeGates(runId, [gate]);

    const streams = capture();
    const res = await runGate({
      action: "approve",
      gateId: gate.id,
      repo,
      now: () => "2026-02-01T12:00:00.000Z",
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(res.exitCode).toBe(EXIT.OK);
    expect(res.gate?.status).toBe("approved");
    expect(res.run?.phase).toBe("Implementing");

    const stored = await store.readGates(runId);
    expect(stored[0]?.status).toBe("approved");
    const run = await store.readRun(runId);
    expect(run?.phase).toBe("Implementing");
  });

  it("rejects plan_approve with explicit --decision cancel", async () => {
    const repo = await tempRepo();
    const store = new StateStore(join(repo, ".lazyorch"));
    const runId = "run_gate3aaaaaaaaaaaaaaaaaaaa";
    await store.writeRun({
      schema_version: SCHEMA_VERSION,
      id: runId,
      project_id: "proj_gate",
      phase: "PlanConsensus",
      idea: "plan",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    const gate: Gate = {
      id: "gate_rejectaaaaaaaaaaaaaaaaaaa",
      type: "plan_approve",
      run_id: runId,
      status: "pending",
      created_at: "2026-01-01T00:00:00.000Z",
      payload: { plan_id: "plan_x" },
    };
    await store.writeGates(runId, [gate]);

    const streams = capture();
    const res = await runGate({
      action: "reject",
      gateId: gate.id,
      decision: "cancel",
      repo,
      now: () => "2026-02-01T12:00:00.000Z",
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(res.exitCode).toBe(EXIT.OK);
    expect(res.gate?.status).toBe("rejected");
    expect(res.run?.phase).toBe("Cancelled");
  });

  it("requires --decision for plan_max_rounds", async () => {
    const repo = await tempRepo();
    const store = new StateStore(join(repo, ".lazyorch"));
    const runId = "run_gate5aaaaaaaaaaaaaaaaaaaa";
    await store.writeRun({
      schema_version: SCHEMA_VERSION,
      id: runId,
      project_id: "proj_gate",
      phase: "Planning",
      idea: "x",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    const gate: Gate = {
      id: "gate_maxroundsaaaaaaaaaaaaaaaa",
      type: "plan_max_rounds",
      run_id: runId,
      status: "pending",
      created_at: "2026-01-01T00:00:00.000Z",
      payload: {
        plan_id: "plan_x",
        rounds: 3,
        open_issues: 1,
        actions: ["force_approve", "edit", "abort"],
      },
    };
    await store.writeGates(runId, [gate]);

    const streams = capture();
    const missing = await runGate({
      action: "approve",
      gateId: gate.id,
      repo,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(missing.exitCode).toBe(EXIT.USAGE);
    expect(streams.stderr.text).toMatch(/--decision/);

    streams.stderr.text = "";
    streams.stdout.text = "";
    const bad = await runGate({
      action: "approve",
      gateId: gate.id,
      decision: "force-approve",
      repo,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(bad.exitCode).toBe(EXIT.USAGE);

    streams.stderr.text = "";
    streams.stdout.text = "";
    const ok = await runGate({
      action: "approve",
      gateId: gate.id,
      decision: "edit",
      repo,
      now: () => "2026-02-01T12:00:00.000Z",
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(ok.exitCode).toBe(EXIT.OK);
    expect(ok.gate?.status).toBe("approved");
  });

  it("plan_dispute requires --decision", async () => {
    const repo = await tempRepo();
    const store = new StateStore(join(repo, ".lazyorch"));
    const runId = "run_gate6aaaaaaaaaaaaaaaaaaaa";
    await store.writeRun({
      schema_version: SCHEMA_VERSION,
      id: runId,
      project_id: "proj_gate",
      phase: "Planning",
      idea: "x",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    const gate: Gate = {
      id: "gate_disputeaaaaaaaaaaaaaaaaaa",
      type: "plan_dispute",
      run_id: runId,
      status: "pending",
      created_at: "2026-01-01T00:00:00.000Z",
      payload: { plan_id: "plan_x", disputed_issue_ids: ["iss_a"] },
    };
    await store.writeGates(runId, [gate]);

    const streams = capture();
    const res = await runGate({
      action: "approve",
      gateId: gate.id,
      decision: "accept_wontfix",
      repo,
      now: () => "2026-02-01T12:00:00.000Z",
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(res.exitCode).toBe(EXIT.OK);
    expect(res.gate?.status).toBe("approved");
  });

  it("merge approve marks should_merge", async () => {
    const repo = await tempRepo();
    const store = new StateStore(join(repo, ".lazyorch"));
    const runId = "run_gate7aaaaaaaaaaaaaaaaaaaa";
    await store.writeRun({
      schema_version: SCHEMA_VERSION,
      id: runId,
      project_id: "proj_gate",
      phase: "MergeReady",
      idea: "x",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      pr_ref: { number: 1, state: "ready" },
    });
    const gate: Gate = {
      id: "gate_mergeaaaaaaaaaaaaaaaaaaaa",
      type: "merge",
      run_id: runId,
      status: "pending",
      created_at: "2026-01-01T00:00:00.000Z",
      payload: { pr_number: 1 },
    };
    await store.writeGates(runId, [gate]);

    const streams = capture();
    const res = await runGate({
      action: "approve",
      gateId: gate.id,
      repo,
      now: () => "2026-02-01T12:00:00.000Z",
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(res.exitCode).toBe(EXIT.OK);
    expect(res.gate?.status).toBe("approved");
    const body = JSON.parse(streams.stdout.text) as { should_merge: boolean };
    expect(body.should_merge).toBe(true);
  });

  it("generic approve for human_intervention", async () => {
    const repo = await tempRepo();
    const store = new StateStore(join(repo, ".lazyorch"));
    const runId = "run_gate4aaaaaaaaaaaaaaaaaaaa";
    await store.writeRun({
      schema_version: SCHEMA_VERSION,
      id: runId,
      project_id: "proj_gate",
      phase: "Implementing",
      idea: "x",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    const gate: Gate = {
      id: "gate_humanaaaaaaaaaaaaaaaaaaaa",
      type: "human_intervention",
      run_id: runId,
      status: "pending",
      created_at: "2026-01-01T00:00:00.000Z",
      payload: {},
    };
    await store.writeGates(runId, [gate]);

    const streams = capture();
    const res = await runGate({
      action: "approve",
      gateId: gate.id,
      repo,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(res.exitCode).toBe(EXIT.OK);
    expect(res.gate?.status).toBe("approved");
  });

  it("usage without gate id", async () => {
    const repo = await tempRepo();
    const streams = capture();
    const res = await runGate({
      action: "approve",
      repo,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(res.exitCode).toBe(EXIT.USAGE);
  });
});
