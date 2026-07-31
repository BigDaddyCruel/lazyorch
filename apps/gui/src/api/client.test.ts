import { describe, expect, it, vi } from "vitest";
import { DaemonApiError, DaemonClient, isUnauthorizedError } from "./client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("DaemonClient", () => {
  it("GETs health with optional bearer", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://127.0.0.1:7420/health");
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer secret");
      return jsonResponse({
        ok: true,
        status: "healthy",
        api_major: 1,
        host: "127.0.0.1",
        port: 7420,
        started_at: "t",
        pid: 1,
      });
    });

    const client = new DaemonClient({
      baseUrl: "http://127.0.0.1:7420/",
      token: "secret",
      useDemoFallback: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const health = await client.getHealth();
    expect(health.ok).toBe(true);
    expect(health.api_major).toBe(1);
  });

  it("throws DaemonApiError on non-OK with status 401", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "unauthorized", message: "Bearer token required" }, 401),
    );
    const client = new DaemonClient({
      baseUrl: "http://127.0.0.1:7420",
      useDemoFallback: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.getStatus()).rejects.toMatchObject({
      name: "DaemonApiError",
      status: 401,
      message: "Bearer token required",
    });
  });

  it("falls back to demo board when runs empty", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ runs: [] }));
    const client = new DaemonClient({
      baseUrl: "http://127.0.0.1:7420",
      useDemoFallback: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const board = await client.getBoardRuns();
    expect(board.source).toBe("demo");
    expect(board.runs.length).toBeGreaterThan(0);
    expect(board.runs[0]?.tasks.length).toBeGreaterThan(0);
  });

  it("returns empty when demo disabled and no runs", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ runs: [] }));
    const client = new DaemonClient({
      baseUrl: "http://127.0.0.1:7420",
      useDemoFallback: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const board = await client.getBoardRuns();
    expect(board.source).toBe("daemon");
    expect(board.runs).toEqual([]);
  });

  it("does not mask 401 with demo board", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "unauthorized", message: "Bearer token required" }, 401),
    );
    const client = new DaemonClient({
      baseUrl: "http://127.0.0.1:7420",
      useDemoFallback: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.getBoardRuns()).rejects.toBeInstanceOf(DaemonApiError);
    await expect(client.getBoardRuns()).rejects.toMatchObject({ status: 401 });
  });

  it("propagates non-auth DaemonApiError from getBoardRuns", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "internal_error", message: "boom" }, 500),
    );
    const client = new DaemonClient({
      baseUrl: "http://127.0.0.1:7420",
      useDemoFallback: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.getBoardRuns()).rejects.toMatchObject({ status: 500 });
  });

  it("lists adapters", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain("/v1/adapters");
      return jsonResponse({
        adapters: [{ id: "shell", source: "builtin", health: "ok" }],
        stub: true,
      });
    });
    const client = new DaemonClient({
      baseUrl: "http://127.0.0.1:7420",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const res = await client.listAdapters();
    expect(res.adapters[0]?.id).toBe("shell");
  });

  it("reconnects SSE after stream EOF", async () => {
    let calls = 0;
    const streamOnce = (): ReadableStream<Uint8Array> =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode('data: {"id":"e1","ts":"t","type":"ping"}\n\n'),
          );
          controller.close();
        },
      });

    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return new Response(streamOnce(), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });

    const client = new DaemonClient({
      baseUrl: "http://127.0.0.1:7420",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const events: string[] = [];
    const reconnects: number[] = [];
    const sub = client.subscribeEvents({
      onEvent: (e) => events.push(e.type),
      onReconnectScheduled: (ms) => reconnects.push(ms),
      maxBackoffMs: 50,
    });

    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(2), { timeout: 2000 });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(reconnects.length).toBeGreaterThanOrEqual(1);
    sub.close();
  });
});

describe("isUnauthorizedError", () => {
  it("detects status 401", () => {
    expect(isUnauthorizedError(new DaemonApiError("Bearer token required", 401, null))).toBe(true);
  });

  it("detects body.error unauthorized", () => {
    expect(isUnauthorizedError(new DaemonApiError("nope", 403, { error: "unauthorized" }))).toBe(
      true,
    );
  });

  it("rejects other errors", () => {
    expect(isUnauthorizedError(new Error("unauthorized"))).toBe(false);
    expect(isUnauthorizedError(new DaemonApiError("boom", 500, null))).toBe(false);
  });
});
