import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { SCHEMA_VERSION, StateStore } from "@lazyorch/core";
import { runContext } from "./context.js";

const temps: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lazyorch-cli-ctx-"));
  temps.push(dir);
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

describe("runContext", () => {
  it("set/get/list/delete against local state store", async () => {
    const root = await tempRoot();
    const store = new StateStore(join(root, ".lazyorch"));
    const runId = "run_cli_ctx";
    await store.writeRun({
      schema_version: SCHEMA_VERSION,
      id: runId,
      project_id: "proj_x",
      phase: "Implementing",
      idea: "cli",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });

    const streams = capture();
    const setRes = await runContext({
      action: "set",
      run: runId,
      key: "port",
      value: "3000",
      repo: root,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(setRes.exitCode).toBe(0);
    expect(JSON.parse(streams.stdout.text).value).toBe(3000);

    streams.stdout.text = "";
    const getRes = await runContext({
      action: "get",
      run: runId,
      key: "port",
      repo: root,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(getRes.exitCode).toBe(0);
    expect(JSON.parse(streams.stdout.text).value).toBe(3000);

    streams.stdout.text = "";
    await runContext({
      action: "set",
      run: runId,
      key: "model_pin/worker",
      value: '"claude"',
      repo: root,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });

    streams.stdout.text = "";
    const listRes = await runContext({
      action: "list",
      run: runId,
      repo: root,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(listRes.exitCode).toBe(0);
    const listed = JSON.parse(streams.stdout.text) as { keys: string[] };
    expect(listed.keys).toEqual(["model_pin/worker", "port"]);

    streams.stdout.text = "";
    const del = await runContext({
      action: "delete",
      run: runId,
      key: "port",
      repo: root,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(del.exitCode).toBe(0);
    expect(del.deleted).toBe(true);
  });

  it("returns errors for missing run/key and usage", async () => {
    const root = await tempRoot();
    const streams = capture();

    const missingRun = await runContext({
      action: "list",
      run: "run_missing",
      repo: root,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(missingRun.exitCode).toBe(1);

    const store = new StateStore(join(root, ".lazyorch"));
    await store.writeRun({
      schema_version: SCHEMA_VERSION,
      id: "run_ok",
      project_id: "p",
      phase: "Inception",
      idea: "x",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });

    const noKey = await runContext({
      action: "get",
      run: "run_ok",
      repo: root,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(noKey.exitCode).toBe(2);

    const missingKey = await runContext({
      action: "get",
      run: "run_ok",
      key: "nope",
      repo: root,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(missingKey.exitCode).toBe(1);
  });
});
