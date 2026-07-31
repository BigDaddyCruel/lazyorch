import { mkdir, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { SCHEMA_VERSION, StateStore } from "@lazyorch/core";
import { ProjectRegistry } from "./project-registry.js";
import {
  matchContextPath,
  parseActorRoleSafe,
  resolveRunContextStore,
  loadWorkerWrite,
  putContextKey,
  deleteContextKey,
  listContextResponse,
  getContextResponse,
} from "./context-routes.js";
import { ContextKvError } from "@lazyorch/core";

const temps: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(async () => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("matchContextPath", () => {
  it("matches list and namespaced keys", () => {
    expect(matchContextPath("/v1/runs/run_abc/context")).toEqual({
      runId: "run_abc",
    });
    expect(matchContextPath("/v1/runs/run_abc/context/port")).toEqual({
      runId: "run_abc",
      key: "port",
    });
    expect(matchContextPath("/v1/runs/run_abc/context/model_pin/worker")).toEqual({
      runId: "run_abc",
      key: "model_pin/worker",
    });
    expect(matchContextPath("/v1/runs/other")).toBeNull();
  });
});

describe("parseActorRoleSafe", () => {
  it("defaults to human and validates", () => {
    expect(parseActorRoleSafe(undefined)).toEqual({ ok: true, role: "human" });
    expect(parseActorRoleSafe("lead")).toEqual({ ok: true, role: "lead" });
    expect(parseActorRoleSafe("WORKER")).toEqual({ ok: true, role: "worker" });
    expect(parseActorRoleSafe("nope").ok).toBe(false);
  });
});

describe("context routes persistence + ACL", () => {
  it("resolves run store, put/get/list/delete with ACL", async () => {
    const home = await tempDir("lazyorch-ctx-home-");
    const repo = await tempDir("lazyorch-ctx-repo-");
    const registry = new ProjectRegistry(home);
    const project = await registry.register({
      id: "proj_ctx",
      repo_root: repo,
      name: "ctx",
    });

    const stateRoot = join(repo, ".lazyorch");
    await mkdir(stateRoot, { recursive: true });
    const store = new StateStore(stateRoot);
    const runId = "run_ctx_demo";
    await store.writeRun({
      schema_version: SCHEMA_VERSION,
      id: runId,
      project_id: project.id,
      phase: "Implementing",
      idea: "ctx",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });

    const resolved = await resolveRunContextStore(registry, runId);
    expect(resolved?.project.id).toBe("proj_ctx");
    expect(resolved?.runId).toBe(runId);

    // lead can write
    const afterPut = await putContextKey(
      resolved!.store,
      runId,
      "port",
      9000,
      "lead",
      false,
    );
    expect(afterPut.kv.port).toBe(9000);

    const listed = listContextResponse(afterPut);
    expect(listed.keys).toEqual(["port"]);
    expect(getContextResponse(afterPut, "port").value).toBe(9000);

    // worker blocked by default
    await expect(
      putContextKey(resolved!.store, runId, "x", 1, "worker", false),
    ).rejects.toBeInstanceOf(ContextKvError);

    // worker allowed when worker_write
    await putContextKey(resolved!.store, runId, "worker_flag", true, "worker", true);

    // reviewer always blocked
    await expect(
      putContextKey(resolved!.store, runId, "y", 1, "reviewer", true),
    ).rejects.toBeInstanceOf(ContextKvError);

    const del = await deleteContextKey(
      resolved!.store,
      runId,
      "port",
      "human",
      false,
    );
    expect(del.deleted).toBe(true);
  });

  it("loadWorkerWrite reads config.yml", async () => {
    const repo = await tempDir("lazyorch-ctx-cfg-");
    const dir = join(repo, ".lazyorch");
    await mkdir(dir, { recursive: true });
    expect(await loadWorkerWrite(repo)).toBe(false);

    await writeFile(
      join(dir, "config.yml"),
      "context:\n  worker_write: true\n",
      "utf8",
    );
    expect(await loadWorkerWrite(repo)).toBe(true);
    expect(await loadWorkerWrite(repo, false)).toBe(false);
  });
});
