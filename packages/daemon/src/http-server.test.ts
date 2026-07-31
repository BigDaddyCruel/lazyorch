import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { SCHEMA_VERSION, StateStore } from "@lazyorch/core";
import { ProjectRegistry } from "./project-registry.js";
import { EventBus } from "./events.js";
import { createDaemonHttpServer } from "./http-server.js";
import { startDaemon, stopDaemon, type ServeResult } from "./serve.js";
import { ensureDaemon } from "./ensure-daemon.js";
import { inspectDaemonLock, readDaemonToken } from "./lockfile.js";

const temps: string[] = [];
const serves: Array<{ serve: ServeResult; home: string }> = [];

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lazyorch-http-"));
  temps.push(dir);
  return dir;
}

afterEach(async () => {
  while (serves.length > 0) {
    const item = serves.pop();
    if (item) {
      try {
        await stopDaemon(item.serve, item.home);
      } catch {
        /* ignore */
      }
    }
  }
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function listenEphemeral(
  home: string,
): Promise<{ base: string; serve: ServeResult }> {
  // port 0 → OS-assigned (avoids Windows excluded port ranges)
  const serve = await startDaemon({
    homeDir: home,
    port: 0,
    attachIfRunning: false,
  });
  serves.push({ serve, home });
  return { base: serve.url, serve };
}

function dropServe(serve: ServeResult): void {
  const idx = serves.findIndex((s) => s.serve === serve);
  if (idx >= 0) serves.splice(idx, 1);
}

describe("daemon HTTP stubs", () => {
  it("health, projects, runs, adapters, models/route", async () => {
    const home = await tempHome();
    const { base, serve } = await listenEphemeral(home);

    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    const healthBody = (await health.json()) as { ok: boolean; api_major: number };
    expect(healthBody.ok).toBe(true);
    expect(healthBody.api_major).toBe(1);

    const healthV1 = await fetch(`${base}/v1/health`);
    expect(healthV1.status).toBe(200);

    // register project
    const repo = join(home, "my-repo");
    const initRes = await fetch(`${base}/v1/projects/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo_root: repo,
        id: "proj_test",
        name: "Demo",
      }),
    });
    expect(initRes.status).toBe(200);
    const initBody = (await initRes.json()) as {
      project: { id: string; name?: string };
    };
    expect(initBody.project.id).toBe("proj_test");
    expect(initBody.project.name).toBe("Demo");

    const projects = await fetch(`${base}/v1/projects`);
    const projectsBody = (await projects.json()) as {
      projects: { id: string }[];
    };
    expect(projectsBody.projects).toHaveLength(1);

    const runs = await fetch(`${base}/v1/runs`);
    const runsBody = (await runs.json()) as { runs: unknown[] };
    expect(runsBody.runs).toEqual([]);

    const adapters = await fetch(`${base}/v1/adapters`);
    const adaptersBody = (await adapters.json()) as {
      adapters: { id: string }[];
      stub: boolean;
    };
    expect(adaptersBody.stub).toBe(true);
    expect(adaptersBody.adapters.map((a) => a.id)).toContain("claude");
    expect(adaptersBody.adapters.map((a) => a.id)).toContain("shell");

    const route = await fetch(`${base}/v1/models/route?role=worker`);
    const routeBody = (await route.json()) as {
      stub: boolean;
      reason: string;
      tier: string;
    };
    expect(routeBody.stub).toBe(true);
    expect(routeBody.reason).toBe("routing_disabled");
    expect(routeBody.tier).toBe("standard");

    const status = await fetch(`${base}/v1/status`);
    const statusBody = (await status.json()) as { project_count: number };
    expect(statusBody.project_count).toBe(1);

    // lockfile written
    const lock = await inspectDaemonLock(home);
    expect(lock.healthy).toBe(true);
    expect(lock.lock?.port).toBe(serve.port);

    await stopDaemon(serve, home);
    dropServe(serve);
  });

  it("SSE /v1/events streams published events", async () => {
    const home = await tempHome();
    const { base, serve } = await listenEphemeral(home);

    const ac = new AbortController();
    const res = await fetch(`${base}/v1/events`, { signal: ac.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);

    const reader = res.body?.getReader();
    expect(reader).toBeTruthy();
    const decoder = new TextDecoder();
    let buffer = "";

    // publish after client connects
    const publishPromise = (async () => {
      await new Promise((r) => setTimeout(r, 50));
      serve.bus?.publish({
        schema_version: 1,
        ts: new Date().toISOString(),
        project_id: "proj_sse",
        type: "phase.changed",
        payload: { from: "a", to: "b" },
        id: "99",
      });
    })();

    const deadline = Date.now() + 3000;
    let sawEvent = false;
    while (Date.now() < deadline && reader) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes("phase.changed") && buffer.includes("proj_sse")) {
        sawEvent = true;
        break;
      }
    }
    await publishPromise;
    ac.abort();
    expect(sawEvent).toBe(true);

    await stopDaemon(serve, home);
    dropServe(serve);
  });

  it("single-instance: second start attaches", async () => {
    const home = await tempHome();
    const first = await startDaemon({
      homeDir: home,
      port: 0,
      attachIfRunning: false,
    });
    serves.push({ serve: first, home });
    expect(first.started).toBe(true);

    const second = await startDaemon({
      homeDir: home,
      attachIfRunning: true,
    });
    expect(second.started).toBe(false);
    expect(second.port).toBe(first.port);
    expect(second.url).toBe(first.url);

    await stopDaemon(first, home);
    dropServe(first);
  });

  it("ensureDaemon starts inline when missing", async () => {
    const home = await tempHome();
    const prev = process.env.LAZYORCH_URL;
    delete process.env.LAZYORCH_URL;

    try {
      const ep = await ensureDaemon({
        homeDir: home,
        mode: "inline",
        port: 0,
        useEnvUrl: false,
      });
      expect(ep.started).toBe(true);
      expect(ep.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const health = await fetch(`${ep.url}/health`);
      expect(health.ok).toBe(true);

      if (ep.serve) {
        await stopDaemon(ep.serve, home);
      }
    } finally {
      if (prev === undefined) delete process.env.LAZYORCH_URL;
      else process.env.LAZYORCH_URL = prev;
    }
  });

  it("context KV GET/PUT/DELETE with write ACL", async () => {
    const home = await tempHome();
    const { base, serve } = await listenEphemeral(home);

    const repo = join(home, "ctx-repo");
    await mkdir(repo, { recursive: true });
    const initRes = await fetch(`${base}/v1/projects/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo_root: repo,
        id: "proj_ctx_http",
        name: "Ctx",
      }),
    });
    expect(initRes.status).toBe(200);

    const runId = "run_ctx_http";
    const store = new StateStore(join(repo, ".lazyorch"));
    await store.writeRun({
      schema_version: SCHEMA_VERSION,
      id: runId,
      project_id: "proj_ctx_http",
      phase: "Implementing",
      idea: "ctx http",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });

    // list empty
    const listEmpty = await fetch(`${base}/v1/runs/${runId}/context`);
    expect(listEmpty.status).toBe(200);
    const listEmptyBody = (await listEmpty.json()) as { keys: string[] };
    expect(listEmptyBody.keys).toEqual([]);

    // human (default) can set
    const put = await fetch(`${base}/v1/runs/${runId}/context/port`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: 7420 }),
    });
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as { key: string; value: number };
    expect(putBody.key).toBe("port");
    expect(putBody.value).toBe(7420);

    // namespaced key
    const putPin = await fetch(
      `${base}/v1/runs/${runId}/context/model_pin/worker`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "claude" }),
      },
    );
    expect(putPin.status).toBe(200);

    const getOne = await fetch(`${base}/v1/runs/${runId}/context/port`);
    expect(getOne.status).toBe(200);
    const getBody = (await getOne.json()) as { value: number };
    expect(getBody.value).toBe(7420);

    const list = await fetch(`${base}/v1/runs/${runId}/context`);
    const listBody = (await list.json()) as { keys: string[] };
    expect(listBody.keys).toEqual(["model_pin/worker", "port"]);

    // worker forbidden by default
    const workerPut = await fetch(`${base}/v1/runs/${runId}/context/x`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-LazyOrch-Actor-Role": "worker",
      },
      body: JSON.stringify({ value: 1 }),
    });
    expect(workerPut.status).toBe(403);

    // lead can write
    const leadPut = await fetch(`${base}/v1/runs/${runId}/context/lead_ok`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-LazyOrch-Actor-Role": "lead",
      },
      body: JSON.stringify({ value: true }),
    });
    expect(leadPut.status).toBe(200);

    // delete
    const del = await fetch(`${base}/v1/runs/${runId}/context/port`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    const getMissing = await fetch(`${base}/v1/runs/${runId}/context/port`);
    expect(getMissing.status).toBe(404);

    // unknown run
    const missingRun = await fetch(`${base}/v1/runs/run_nope/context`);
    expect(missingRun.status).toBe(404);

    await stopDaemon(serve, home);
    dropServe(serve);
  });

  it("createDaemonHttpServer 404 for unknown path", async () => {
    const home = await tempHome();
    const registry = new ProjectRegistry(home);
    const bus = new EventBus();
    const http = createDaemonHttpServer({
      registry,
      bus,
      token: "t",
      startedAt: new Date().toISOString(),
      host: "127.0.0.1",
      port: 0,
    });
    await new Promise<void>((resolve, reject) => {
      http.server.once("error", reject);
      http.server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = http.server.address();
    if (!addr || typeof addr === "string") throw new Error("no addr");
    const res = await fetch(`http://127.0.0.1:${addr.port}/v1/nope`);
    expect(res.status).toBe(404);
    await http.close();
  });

  it("requireAuth: Bearer required; health public", async () => {
    const home = await tempHome();
    const serve = await startDaemon({
      homeDir: home,
      port: 0,
      attachIfRunning: false,
      requireAuth: true,
      token: "good-token",
    });
    serves.push({ serve, home });

    const health = await fetch(`${serve.url}/health`);
    expect(health.status).toBe(200);

    const noTok = await fetch(`${serve.url}/v1/projects`);
    expect(noTok.status).toBe(401);

    const bad = await fetch(`${serve.url}/v1/projects`, {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(bad.status).toBe(401);

    const ok = await fetch(`${serve.url}/v1/projects`, {
      headers: { Authorization: "Bearer good-token" },
    });
    expect(ok.status).toBe(200);

    await stopDaemon(serve, home);
    dropServe(serve);
  });

  it("stopDaemon completes quickly with open SSE client", async () => {
    const home = await tempHome();
    const { base, serve } = await listenEphemeral(home);

    const ac = new AbortController();
    const res = await fetch(`${base}/v1/events`, { signal: ac.signal });
    expect(res.status).toBe(200);
    // leave stream open

    const stop = stopDaemon(serve, home);
    await expect(
      Promise.race([
        stop.then(() => "ok"),
        new Promise<string>((r) => setTimeout(() => r("timeout"), 2000)),
      ]),
    ).resolves.toBe("ok");

    ac.abort();
    dropServe(serve);
  });

  it("concurrent start: one owner; disk token matches owner and attachers", async () => {
    const home = await tempHome();
    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        startDaemon({
          homeDir: home,
          port: 0,
          attachIfRunning: true,
          attachRetryMs: 5000,
          requireAuth: true,
        }),
      ),
    );

    const owners = results.filter((r) => r.started);
    expect(owners).toHaveLength(1);
    const owner = owners[0]!;
    serves.push({ serve: owner, home });

    // All results share the same endpoint
    for (const r of results) {
      expect(r.port).toBe(owner.port);
      expect(r.url).toBe(owner.url);
    }

    // Disk token equals owner's in-memory token (no loser overwrite)
    const diskToken = await readDaemonToken(home);
    expect(diskToken).toBe(owner.token);
    for (const r of results) {
      expect(r.token).toBe(owner.token);
    }

    // Bearer with disk token works against requireAuth owner
    const ok = await fetch(`${owner.url}/v1/projects`, {
      headers: { Authorization: `Bearer ${diskToken}` },
    });
    expect(ok.status).toBe(200);

    const bad = await fetch(`${owner.url}/v1/projects`, {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(bad.status).toBe(401);

    await stopDaemon(owner, home);
    dropServe(owner);
  });
});
