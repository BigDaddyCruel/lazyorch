import { describe, expect, it, vi } from "vitest";
import { DaemonApiError, DaemonClient } from "./client.js";

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

  it("throws DaemonApiError on non-OK", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "unauthorized", message: "Bearer token required" }, 401),
    );
    const client = new DaemonClient({
      baseUrl: "http://127.0.0.1:7420",
      useDemoFallback: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.getStatus()).rejects.toBeInstanceOf(DaemonApiError);
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
});
