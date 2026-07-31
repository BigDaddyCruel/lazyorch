import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { DaemonClient, isUnauthorizedError } from "../api/client.js";
import type {
  AdapterInfo,
  BoardRun,
  EventEnvelope,
  HealthResponse,
  ModelRouteResponse,
  RegisteredProject,
  StatusResponse,
} from "../api/types.js";
import { loadSettings, saveSettings, type GuiSettings } from "../lib/settings.js";

export type PageId = "home" | "board" | "plan" | "agents" | "logs" | "settings";

export type ConnectionState = "connecting" | "online" | "offline" | "unauthorized";

export type SseState = "off" | "connecting" | "live" | "reconnecting";

const AUTH_GUIDANCE =
  "Bearer token required. Paste the token from ~/.lazyorch/daemon.token under Settings.";

interface AppStateValue {
  page: PageId;
  setPage: (p: PageId) => void;
  settings: GuiSettings;
  /** Persist settings and return a client built from them (for immediate refresh). */
  updateSettings: (next: GuiSettings) => DaemonClient;
  client: DaemonClient;
  connection: ConnectionState;
  sseState: SseState;
  health: HealthResponse | null;
  status: StatusResponse | null;
  projects: RegisteredProject[];
  adapters: AdapterInfo[];
  modelRoute: ModelRouteResponse | null;
  runs: BoardRun[];
  boardSource: "daemon" | "demo" | "mixed" | null;
  selectedRunId: string | null;
  setSelectedRunId: (id: string | null) => void;
  selectedRun: BoardRun | null;
  events: EventEnvelope[];
  lastError: string | null;
  /** Optional client override so Settings can refresh with the post-save client. */
  refresh: (withClient?: DaemonClient) => Promise<void>;
  refreshing: boolean;
}

const AppStateContext = createContext<AppStateValue | null>(null);

export function buildClient(settings: GuiSettings): DaemonClient {
  const token = settings.token.trim();
  const cfg: ConstructorParameters<typeof DaemonClient>[0] = {
    baseUrl: settings.daemonUrl,
    useDemoFallback: settings.useDemoFallback,
  };
  if (token) cfg.token = token;
  return new DaemonClient(cfg);
}

function applyUnauthorized(
  setConnection: (c: ConnectionState) => void,
  setLastError: (e: string | null) => void,
  setRuns: (r: BoardRun[]) => void,
  setBoardSource: (s: "daemon" | "demo" | "mixed" | null) => void,
  setAdapters: (a: AdapterInfo[]) => void,
  setModelRoute: (m: ModelRouteResponse | null) => void,
  setStatus: (s: StatusResponse | null) => void,
  setProjects: (p: RegisteredProject[]) => void,
  message?: string,
): void {
  setConnection("unauthorized");
  setLastError(message && message.trim() ? `${message} — ${AUTH_GUIDANCE}` : AUTH_GUIDANCE);
  // Do not substitute demo data for auth failures
  setRuns([]);
  setBoardSource(null);
  setAdapters([]);
  setModelRoute(null);
  setStatus(null);
  setProjects([]);
}

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [page, setPage] = useState<PageId>("home");
  const [settings, setSettings] = useState<GuiSettings>(() => loadSettings());
  const [client, setClient] = useState(() => buildClient(loadSettings()));
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [sseState, setSseState] = useState<SseState>("off");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [projects, setProjects] = useState<RegisteredProject[]>([]);
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [modelRoute, setModelRoute] = useState<ModelRouteResponse | null>(null);
  const [runs, setRuns] = useState<BoardRun[]>([]);
  const [boardSource, setBoardSource] = useState<"daemon" | "demo" | "mixed" | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [events, setEvents] = useState<EventEnvelope[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const clientRef = useRef(client);
  clientRef.current = client;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const refreshGen = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const sseRef = useRef<{ close: () => void } | null>(null);

  const updateSettings = useCallback((next: GuiSettings): DaemonClient => {
    saveSettings(next);
    setSettings(next);
    const nextClient = buildClient(next);
    setClient(nextClient);
    return nextClient;
  }, []);

  const refresh = useCallback(async (withClient?: DaemonClient) => {
    const c = withClient ?? clientRef.current;
    const useDemo = settingsRef.current.useDemoFallback;
    const gen = ++refreshGen.current;

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const signal = ac.signal;

    setRefreshing(true);
    setLastError(null);

    const stale = (): boolean => gen !== refreshGen.current || signal.aborted;

    try {
      // 1) Public liveness (does not prove auth)
      const h = await c.getHealth({ signal });
      if (stale()) return;
      setHealth(h);

      // 2) Authenticated gate — browser Origin always requires Bearer
      let st: StatusResponse;
      try {
        st = await c.getStatus({ signal });
      } catch (err) {
        if (stale()) return;
        if (isUnauthorizedError(err)) {
          applyUnauthorized(
            setConnection,
            setLastError,
            setRuns,
            setBoardSource,
            setAdapters,
            setModelRoute,
            setStatus,
            setProjects,
            err instanceof Error ? err.message : undefined,
          );
          return;
        }
        throw err;
      }
      if (stale()) return;

      setConnection("online");
      setStatus(st);
      setProjects(st.projects ?? []);

      // 3) Parallel secondary fetches (auth already proven)
      const [adResult, routeResult, boardResult] = await Promise.all([
        c.listAdapters({ signal }).then(
          (v) => ({ ok: true as const, v }),
          (e: unknown) => ({ ok: false as const, e }),
        ),
        c.routeModel("worker", undefined, { signal }).then(
          (v) => ({ ok: true as const, v }),
          (e: unknown) => ({ ok: false as const, e }),
        ),
        c.getBoardRuns(undefined, { signal }).then(
          (v) => ({ ok: true as const, v }),
          (e: unknown) => ({ ok: false as const, e }),
        ),
      ]);
      if (stale()) return;

      for (const r of [adResult, routeResult, boardResult]) {
        if (!r.ok && isUnauthorizedError(r.e)) {
          applyUnauthorized(
            setConnection,
            setLastError,
            setRuns,
            setBoardSource,
            setAdapters,
            setModelRoute,
            setStatus,
            setProjects,
            r.e instanceof Error ? r.e.message : undefined,
          );
          return;
        }
      }

      if (adResult.ok) setAdapters(adResult.v.adapters);
      else setAdapters([]);

      if (routeResult.ok) setModelRoute(routeResult.v);
      else setModelRoute(null);

      if (boardResult.ok) {
        setRuns(boardResult.v.runs);
        setBoardSource(boardResult.v.source);
        setSelectedRunId((prev) => {
          if (prev && boardResult.v.runs.some((r) => r.id === prev)) return prev;
          return boardResult.v.runs[0]?.id ?? null;
        });
      } else {
        setLastError(
          boardResult.e instanceof Error ? boardResult.e.message : String(boardResult.e),
        );
        setRuns([]);
        setBoardSource(null);
      }
    } catch (err) {
      if (stale()) return;
      if (isUnauthorizedError(err)) {
        applyUnauthorized(
          setConnection,
          setLastError,
          setRuns,
          setBoardSource,
          setAdapters,
          setModelRoute,
          setStatus,
          setProjects,
          err instanceof Error ? err.message : undefined,
        );
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      setConnection("offline");
      setLastError(msg);
      // Demo only on transport offline — never for auth
      if (useDemo) {
        const board = c.getDemoBoardRuns();
        setRuns(board.runs);
        setBoardSource(board.source);
        setSelectedRunId((prev) => prev ?? board.runs[0]?.id ?? null);
        setEvents(c.getDemoEvents());
      }
    } finally {
      if (gen === refreshGen.current) {
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [client, refresh]);

  useEffect(() => {
    const id = window.setInterval(() => {
      void refresh();
    }, settings.pollMs);
    return () => window.clearInterval(id);
  }, [refresh, settings.pollMs]);

  useEffect(() => {
    sseRef.current?.close();
    sseRef.current = null;

    if (connection !== "online") {
      setSseState("off");
      return;
    }

    setSseState("connecting");
    const sub = client.subscribeEvents({
      onEvent: (evt) => {
        setEvents((prev) => [evt, ...prev].slice(0, 200));
      },
      onOpen: () => setSseState("live"),
      onReconnectScheduled: () => setSseState("reconnecting"),
      onError: (err) => {
        if (isUnauthorizedError(err)) {
          setConnection("unauthorized");
          setLastError(AUTH_GUIDANCE);
          setSseState("off");
        }
      },
    });
    sseRef.current = sub;
    return () => {
      sub.close();
      sseRef.current = null;
    };
  }, [client, connection]);

  // Seed demo events once when empty and offline/demo
  useEffect(() => {
    if (events.length === 0 && boardSource === "demo" && connection === "offline") {
      setEvents(client.getDemoEvents());
    }
  }, [boardSource, client, connection, events.length]);

  const selectedRun = useMemo(
    () => runs.find((r) => r.id === selectedRunId) ?? null,
    [runs, selectedRunId],
  );

  const value = useMemo<AppStateValue>(
    () => ({
      page,
      setPage,
      settings,
      updateSettings,
      client,
      connection,
      sseState,
      health,
      status,
      projects,
      adapters,
      modelRoute,
      runs,
      boardSource,
      selectedRunId,
      setSelectedRunId,
      selectedRun,
      events,
      lastError,
      refresh,
      refreshing,
    }),
    [
      page,
      settings,
      updateSettings,
      client,
      connection,
      sseState,
      health,
      status,
      projects,
      adapters,
      modelRoute,
      runs,
      boardSource,
      selectedRunId,
      selectedRun,
      events,
      lastError,
      refresh,
      refreshing,
    ],
  );

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppStateValue {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error("useAppState must be used within AppStateProvider");
  return ctx;
}
