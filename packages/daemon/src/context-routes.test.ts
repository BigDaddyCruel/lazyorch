import { mkdir, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { SCHEMA_VERSION, StateStore, ContextKvError } from "@lazyorch/core";
import { ProjectRegistry } from "./project-registry.js";
import {
  matchContextPath,
  parseActorRoleSafe,
  resolveWriteActor,
  resolveRunContextStore,
  loadWorkerWrite,
  putContextKey,
  deleteContextKey,
  listContextResponse,
  getContextResponse,
  withContextWriteLock,
} from "./context-routes.js";

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

describe("parseActorRoleSafe / resolveWriteActor", () => {
  it("defaults to human only with bearer", () => {
    expect(parseActorRoleSafe(undefined, { bearerOk: true })).toEqual({
      ok: true,
      role: "human",
    });
    expect(parseActorRoleSafe(undefined, { bearerOk: false }).ok).toBe(false);
    expect(parseActorRoleSafe("lead", { bearerOk: true })).toEqual({
      ok: true,
      role: "lead",
    });
    expect(parseActorRoleSafe("WORKER", { bearerOk: true })).toEqual({
      ok: true,
      role: "worker",
    });
    expect(parseActorRoleSafe("nope", { bearerOk: true }).ok).toBe(false);
  });

  it("resolveWriteActor requires bearer", () => {
    expect(resolveWriteActor(undefined, false).ok).toBe(false);
    if (!resolveWriteActor(undefined, false).ok) {
      expect(resolveWriteActor(undefined, false).status).toBe(401);
    }
    const ok = resolveWriteActor(undefined, true);
    expect(ok).toEqual({ ok: true, role: "human" });
    expect(resolveWriteActor("worker", true)).toEqual({
      ok: true,
      role: "worker",
    });
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
    expect(resolved.status).toBe("ok");
    if (resolved.status !== "ok") return;
    expect(resolved.resolved.project.id).toBe("proj_ctx");
    expect(resolved.resolved.runId).toBe(runId);

    const afterPut = await putContextKey(
      resolved.resolved.store,
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

    await expect(
      putContextKey(resolved.resolved.store, runId, "x", 1, "worker", false),
    ).rejects.toBeInstanceOf(ContextKvError);

    await putContextKey(
      resolved.resolved.store,
      runId,
      "worker_flag",
      true,
      "worker",
      true,
    );

    await expect(
      putContextKey(resolved.resolved.store, runId, "y", 1, "reviewer", true),
    ).rejects.toBeInstanceOf(ContextKvError);

    const del = await deleteContextKey(
      resolved.resolved.store,
      runId,
      "port",
      "human",
      false,
    );
    expect(del.deleted).toBe(true);
  });

  it("returns ambiguous when run id collides across projects", async () => {
    const home = await tempDir("lazyorch-ctx-amb-home-");
    const repoA = await tempDir("lazyorch-ctx-amb-a-");
    const repoB = await tempDir("lazyorch-ctx-amb-b-");
    const registry = new ProjectRegistry(home);
    await registry.register({ id: "proj_a", repo_root: repoA });
    await registry.register({ id: "proj_b", repo_root: repoB });

    const runId = "run_collide";
    for (const [repo, proj] of [
      [repoA, "proj_a"],
      [repoB, "proj_b"],
    ] as const) {
      const store = new StateStore(join(repo, ".lazyorch"));
      await store.writeRun({
        schema_version: SCHEMA_VERSION,
        id: runId,
        project_id: proj,
        phase: "Inception",
        idea: "x",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      });
    }

    const amb = await resolveRunContextStore(registry, runId);
    expect(amb.status).toBe("ambiguous");
    if (amb.status === "ambiguous") {
      expect(amb.project_ids).toEqual(["proj_a", "proj_b"]);
    }

    const pinned = await resolveRunContextStore(registry, runId, "proj_b");
    expect(pinned.status).toBe("ok");
    if (pinned.status === "ok") {
      expect(pinned.resolved.project.id).toBe("proj_b");
    }
  });

  it("serializes concurrent writes for the same run", async () => {
    const home = await tempDir("lazyorch-ctx-lock-home-");
    const repo = await tempDir("lazyorch-ctx-lock-repo-");
    const registry = new ProjectRegistry(home);
    await registry.register({ id: "proj_lock", repo_root: repo });
    const store = new StateStore(join(repo, ".lazyorch"));
    const runId = "run_lock";
    await store.writeRun({
      schema_version: SCHEMA_VERSION,
      id: runId,
      project_id: "proj_lock",
      phase: "Implementing",
      idea: "lock",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });

    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        withContextWriteLock(runId, () =>
          store.setContextKey(runId, `k${i}`, i),
        ),
      ),
    );

    const ctx = await store.readContext(runId);
    expect(Object.keys(ctx?.kv ?? {}).length).toBe(20);
    for (let i = 0; i < 20; i++) {
      expect(ctx?.kv[`k${i}`]).toBe(i);
    }
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
