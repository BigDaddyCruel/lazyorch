import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { SCHEMA_VERSION, StateStore, type Gate } from "@lazyorch/core";
import { runRunCommand } from "./run.js";
import { EXIT } from "../exit-codes.js";

const temps: string[] = [];

async function tempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lazyorch-cli-run-"));
  temps.push(dir);
  await mkdir(join(dir, ".lazyorch"), { recursive: true });
  await writeFile(
    join(dir, ".lazyorch", "project.json"),
    JSON.stringify({
      schema_version: SCHEMA_VERSION,
      id: "proj_run",
      repo_root: dir,
      name: "run",
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

describe("runRunCommand", () => {
  it("lists runs", async () => {
    const repo = await tempRepo();
    const store = new StateStore(join(repo, ".lazyorch"));
    await store.writeRun({
      schema_version: SCHEMA_VERSION,
      id: "run_list1aaaaaaaaaaaaaaaaaaaa",
      project_id: "proj_run",
      phase: "Inception",
      idea: "a",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    const streams = capture();
    const res = await runRunCommand({
      action: "list",
      repo,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(res.exitCode).toBe(EXIT.OK);
    expect(res.runs).toHaveLength(1);
  });

  it("show is observational (exit 0) with pending gates", async () => {
    const repo = await tempRepo();
    const store = new StateStore(join(repo, ".lazyorch"));
    const runId = "run_show1aaaaaaaaaaaaaaaaaaaa";
    await store.writeRun({
      schema_version: SCHEMA_VERSION,
      id: runId,
      project_id: "proj_run",
      phase: "PlanConsensus",
      idea: "show",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    const gate: Gate = {
      id: "gate_showaaaaaaaaaaaaaaaaaaaaa",
      type: "human_intervention",
      run_id: runId,
      status: "pending",
      created_at: "2026-01-01T00:00:00.000Z",
      payload: {},
    };
    await store.writeGates(runId, [gate]);

    const streams = capture();
    const res = await runRunCommand({
      action: "show",
      runId,
      repo,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(res.exitCode).toBe(EXIT.OK);
    expect(res.gates).toHaveLength(1);
  });

  it("show --check exits 3 when pending", async () => {
    const repo = await tempRepo();
    const store = new StateStore(join(repo, ".lazyorch"));
    const runId = "run_show2aaaaaaaaaaaaaaaaaaaa";
    await store.writeRun({
      schema_version: SCHEMA_VERSION,
      id: runId,
      project_id: "proj_run",
      phase: "PlanConsensus",
      idea: "show",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    await store.writeGates(runId, [
      {
        id: "gate_showbbbbbbbbbbbbbbbbbbbbb",
        type: "human_intervention",
        run_id: runId,
        status: "pending",
        created_at: "2026-01-01T00:00:00.000Z",
        payload: {},
      },
    ]);

    const streams = capture();
    const res = await runRunCommand({
      action: "show",
      runId,
      check: true,
      repo,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(res.exitCode).toBe(EXIT.GATE);
  });

  it("usage when show missing id", async () => {
    const repo = await tempRepo();
    const streams = capture();
    const res = await runRunCommand({
      action: "show",
      repo,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(res.exitCode).toBe(EXIT.USAGE);
  });
});
