import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { SCHEMA_VERSION, StateStore, type Gate } from "@lazyorch/core";
import { runStatus } from "./status.js";
import { EXIT } from "../exit-codes.js";

const temps: string[] = [];

async function tempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lazyorch-cli-status-"));
  temps.push(dir);
  const lazy = join(dir, ".lazyorch");
  await mkdir(lazy, { recursive: true });
  await writeFile(
    join(lazy, "project.json"),
    JSON.stringify({
      schema_version: SCHEMA_VERSION,
      id: "proj_status",
      repo_root: dir,
      name: "status",
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

describe("runStatus", () => {
  it("lists runs and daemon snapshot", async () => {
    const repo = await tempRepo();
    const store = new StateStore(join(repo, ".lazyorch"));
    await store.writeRun({
      schema_version: SCHEMA_VERSION,
      id: "run_status1aaaaaaaaaaaaaaaaaa",
      project_id: "proj_status",
      phase: "Implementing",
      idea: "hi",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });

    const streams = capture();
    const res = await runStatus({
      repo,
      stdout: streams.stdout,
      stderr: streams.stderr,
      daemonStatus: async () => ({
        url: "http://127.0.0.1:7420",
        ok: true,
        project_count: 1,
        run_count: 0,
      }),
    });
    expect(res.exitCode).toBe(EXIT.OK);
    expect(res.runs).toHaveLength(1);
    expect(res.daemon?.url).toBe("http://127.0.0.1:7420");
  });

  it("default observational: exit 0 with pending gate on single-run", async () => {
    const repo = await tempRepo();
    const store = new StateStore(join(repo, ".lazyorch"));
    const runId = "run_status2aaaaaaaaaaaaaaaaaa";
    await store.writeRun({
      schema_version: SCHEMA_VERSION,
      id: runId,
      project_id: "proj_status",
      phase: "PlanConsensus",
      idea: "plan me",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    const gate: Gate = {
      id: "gate_statusaaaaaaaaaaaaaaaaaaa",
      type: "plan_approve",
      run_id: runId,
      status: "pending",
      created_at: "2026-01-01T00:00:00.000Z",
      payload: { plan_id: "plan_x" },
    };
    await store.writeGates(runId, [gate]);

    const streams = capture();
    const res = await runStatus({
      repo,
      runId,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(res.exitCode).toBe(EXIT.OK);
    expect(res.pendingGates).toHaveLength(1);
  });

  it("exits 3 only with gateExit / --check", async () => {
    const repo = await tempRepo();
    const store = new StateStore(join(repo, ".lazyorch"));
    const runId = "run_status3aaaaaaaaaaaaaaaaaa";
    await store.writeRun({
      schema_version: SCHEMA_VERSION,
      id: runId,
      project_id: "proj_status",
      phase: "PlanConsensus",
      idea: "plan me",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    await store.writeGates(runId, [
      {
        id: "gate_statusbbbbbbbbbbbbbbbbbbb",
        type: "plan_approve",
        run_id: runId,
        status: "pending",
        created_at: "2026-01-01T00:00:00.000Z",
        payload: { plan_id: "plan_x" },
      },
    ]);

    const streams = capture();
    const res = await runStatus({
      repo,
      runId,
      gateExit: true,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(res.exitCode).toBe(EXIT.GATE);
  });

  it("errors when run missing", async () => {
    const repo = await tempRepo();
    const streams = capture();
    const res = await runStatus({
      repo,
      runId: "run_missingaaaaaaaaaaaaaaaaaa",
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(res.exitCode).toBe(EXIT.ERROR);
  });
});
