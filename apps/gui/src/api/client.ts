import { createDemoEvents, createDemoRuns } from "./demo-data.js";
import type {
  AdaptersResponse,
  BoardRun,
  DaemonClientConfig,
  DaemonRun,
  EventEnvelope,
  HealthResponse,
  ModelRouteResponse,
  RegisteredProject,
  StatusResponse,
} from "./types.js";

export class DaemonApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "DaemonApiError";
    this.status = status;
    this.body = body;
  }
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Thin HTTP client for the LazyOrch user-level daemon.
 * No orchestration — pure fetch wrappers + optional demo fill-in.
 */
export class DaemonClient {
  readonly baseUrl: string;
  readonly token: string | undefined;
  readonly useDemoFallback: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(config: DaemonClientConfig) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.token = config.token;
    this.useDemoFallback = config.useDemoFallback ?? true;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  withConfig(partial: Partial<DaemonClientConfig>): DaemonClient {
    const nextToken = partial.token !== undefined ? partial.token : this.token;
    const cfg: DaemonClientConfig = {
      baseUrl: partial.baseUrl ?? this.baseUrl,
      useDemoFallback:
        partial.useDemoFallback !== undefined
          ? partial.useDemoFallback
          : this.useDemoFallback,
      fetchImpl: partial.fetchImpl ?? this.fetchImpl,
    };
    if (nextToken !== undefined) cfg.token = nextToken;
    return new DaemonClient(cfg);
  }

  private headers(extra?: HeadersInit): Headers {
    const h = new Headers(extra);
    if (!h.has("Accept")) h.set("Accept", "application/json");
    if (this.token) h.set("Authorization", `Bearer ${this.token}`);
    return h;
  }

  async requestJson<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const res = await this.fetchImpl(url, {
      ...init,
      headers: this.headers(init?.headers),
    });
    let body: unknown = null;
    const text = await res.text();
    if (text) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }
    if (!res.ok) {
      const msg =
        typeof body === "object" &&
        body !== null &&
        "message" in body &&
        typeof (body as { message: unknown }).message === "string"
          ? (body as { message: string }).message
          : `HTTP ${res.status}`;
      throw new DaemonApiError(msg, res.status, body);
    }
    return body as T;
  }

  getHealth(): Promise<HealthResponse> {
    return this.requestJson<HealthResponse>("/health");
  }

  getStatus(): Promise<StatusResponse> {
    return this.requestJson<StatusResponse>("/v1/status");
  }

  listProjects(): Promise<{ projects: RegisteredProject[] }> {
    return this.requestJson<{ projects: RegisteredProject[] }>("/v1/projects");
  }

  listRuns(projectId?: string): Promise<{ runs: DaemonRun[] }> {
    const q = projectId ? `?project=${encodeURIComponent(projectId)}` : "";
    return this.requestJson<{ runs: DaemonRun[] }>(`/v1/runs${q}`);
  }

  listAdapters(): Promise<AdaptersResponse> {
    return this.requestJson<AdaptersResponse>("/v1/adapters");
  }

  routeModel(role = "worker", task?: string): Promise<ModelRouteResponse> {
    const params = new URLSearchParams({ role });
    if (task) params.set("task", task);
    return this.requestJson<ModelRouteResponse>(`/v1/models/route?${params}`);
  }

  /**
   * Build board runs: live stub list from daemon, enriched with demo detail
   * when the daemon has no rich payload yet (MVP).
   */
  async getBoardRuns(projectId?: string): Promise<{
    runs: BoardRun[];
    source: "daemon" | "demo" | "mixed";
  }> {
    try {
      const { runs } = await this.listRuns(projectId);
      if (runs.length === 0 && this.useDemoFallback) {
        return { runs: createDemoRuns(), source: "demo" };
      }
      if (runs.length === 0) {
        return { runs: [], source: "daemon" };
      }
      // Stubs only have phase/idea — enrich with empty board collections
      // and optionally merge demo for known demo ids.
      const demoById = new Map(createDemoRuns().map((r) => [r.id, r]));
      const board: BoardRun[] = runs.map((r) => {
        const demo = demoById.get(r.id);
        if (demo) return { ...demo, ...r, idea: r.idea ?? demo.idea };
        return {
          ...r,
          idea: r.idea ?? "",
          tasks: [],
          gates: [],
          agents: [],
        };
      });
      const mixed = board.some((b) => (b.tasks?.length ?? 0) > 0 && demoById.has(b.id));
      return { runs: board, source: mixed ? "mixed" : "daemon" };
    } catch {
      if (this.useDemoFallback) {
        return { runs: createDemoRuns(), source: "demo" };
      }
      throw new Error("Failed to load runs from daemon");
    }
  }

  /** Best-effort event snapshot (SSE live stream is separate). */
  getDemoEvents(): EventEnvelope[] {
    return createDemoEvents();
  }

  /**
   * Open SSE to /v1/events. Returns an abort handle.
   * Browser EventSource cannot set Authorization; when a token is required
   * we fall back to fetch streaming (or skip). For loopback without Origin
   * auth this works; with Origin (browser), Bearer is required — use
   * fetch-based stream when token present.
   */
  subscribeEvents(options: {
    projectId?: string;
    onEvent: (event: EventEnvelope) => void;
    onError?: (err: unknown) => void;
    onOpen?: () => void;
  }): { close: () => void } {
    const params = new URLSearchParams();
    if (options.projectId) params.set("project", options.projectId);
    const qs = params.toString();
    const url = `${this.baseUrl}/v1/events${qs ? `?${qs}` : ""}`;

    const ac = new AbortController();
    let closed = false;

    const run = async (): Promise<void> => {
      try {
        const res = await this.fetchImpl(url, {
          headers: this.headers({ Accept: "text/event-stream" }),
          signal: ac.signal,
        });
        if (!res.ok || !res.body) {
          throw new DaemonApiError(`SSE HTTP ${res.status}`, res.status, null);
        }
        options.onOpen?.();
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!closed) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const block of parts) {
            const dataLine = block
              .split("\n")
              .find((l) => l.startsWith("data:"));
            if (!dataLine) continue;
            const raw = dataLine.replace(/^data:\s?/, "").trim();
            if (!raw || raw === "[DONE]") continue;
            try {
              const parsed = JSON.parse(raw) as EventEnvelope;
              options.onEvent(parsed);
            } catch {
              // ignore malformed SSE payloads
            }
          }
        }
      } catch (err) {
        if (!closed && !(err instanceof DOMException && err.name === "AbortError")) {
          options.onError?.(err);
        }
      }
    };

    void run();

    return {
      close: () => {
        closed = true;
        ac.abort();
      },
    };
  }
}

export function defaultDaemonUrl(): string {
  if (typeof import.meta !== "undefined" && import.meta.env?.VITE_LAZYORCH_URL) {
    return import.meta.env.VITE_LAZYORCH_URL;
  }
  return "http://127.0.0.1:7420";
}

export function defaultDaemonToken(): string | undefined {
  if (typeof import.meta !== "undefined" && import.meta.env?.VITE_LAZYORCH_TOKEN) {
    const t = import.meta.env.VITE_LAZYORCH_TOKEN;
    return t.length > 0 ? t : undefined;
  }
  return undefined;
}

export function defaultUseDemo(): boolean {
  if (typeof import.meta !== "undefined" && import.meta.env?.VITE_USE_DEMO === "0") {
    return false;
  }
  return true;
}

export function createDefaultClient(): DaemonClient {
  const cfg: DaemonClientConfig = {
    baseUrl: defaultDaemonUrl(),
    useDemoFallback: defaultUseDemo(),
  };
  const token = defaultDaemonToken();
  if (token !== undefined) cfg.token = token;
  return new DaemonClient(cfg);
}
