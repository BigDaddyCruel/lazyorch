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
import { DaemonClient } from "../api/client.js";
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

export type PageId =
  | "home"
  | "board"
  | "plan"
  | "agents"
  | "logs"
  | "settings";

export type ConnectionState = "connecting" | "online" | "offline" | "unauthorized";

interface AppStateValue {
  page: PageId;
  setPage: (p: PageId) => void;
  settings: GuiSettings;
  updateSettings: (next: GuiSettings) => void;
  client: DaemonClient;
  connection: ConnectionState;
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
  refresh: () => Promise<void>;
  refreshing: boolean;
}

const AppStateContext = createContext<AppStateValue | null>(null);

function buildClient(settings: GuiSettings): DaemonClient {
  const token = settings.token.trim();
  const cfg: ConstructorParameters<typeof DaemonClient>[0] = {
    baseUrl: settings.daemonUrl,
    useDemoFallback: settings.useDemoFallback,
  };
  if (token) cfg.token = token;
  return new DaemonClient(cfg);
}

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [page, setPage] = useState<PageId>("home");
  const [settings, setSettings] = useState<GuiSettings>(() => loadSettings());
  const [client, setClient] = useState(() => buildClient(loadSettings()));
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [projects, setProjects] = useState<RegisteredProject[]>([]);
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [modelRoute, setModelRoute] = useState<ModelRouteResponse | null>(null);
  const [runs, setRuns] = useState<BoardRun[]>([]);
  const [boardSource, setBoardSource] = useState<"daemon" | "demo" | "mixed" | null>(
    null,
  );
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [events, setEvents] = useState<EventEnvelope[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const sseRef = useRef<{ close: () => void } | null>(null);

  const updateSettings = useCallback((next: GuiSettings) => {
    saveSettings(next);
    setSettings(next);
    setClient(buildClient(next));
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setLastError(null);
    try {
      const h = await client.getHealth();
      setHealth(h);
      setConnection("online");

      const [st, ad, route, board] = await Promise.all([
        client.getStatus().catch(() => null),
        client.listAdapters().catch(() => ({ adapters: [] as AdapterInfo[] })),
        client.routeModel("worker").catch(() => null),
        client.getBoardRuns(),
      ]);

      if (st) {
        setStatus(st);
        setProjects(st.projects ?? []);
      } else {
        const proj = await client.listProjects().catch(() => ({ projects: [] }));
        setProjects(proj.projects);
      }
      setAdapters(ad.adapters);
      setModelRoute(route);
      setRuns(board.runs);
      setBoardSource(board.source);
      setSelectedRunId((prev) => {
        if (prev && board.runs.some((r) => r.id === prev)) return prev;
        return board.runs[0]?.id ?? null;
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes("401") || msg.toLowerCase().includes("unauthorized")) {
        setConnection("unauthorized");
      } else {
        setConnection("offline");
      }
      setLastError(msg);
      // Still surface demo board offline when enabled
      if (settings.useDemoFallback) {
        try {
          const board = await client.getBoardRuns();
          setRuns(board.runs);
          setBoardSource(board.source);
          setSelectedRunId((prev) => prev ?? board.runs[0]?.id ?? null);
          setEvents(client.getDemoEvents());
        } catch {
          /* ignore */
        }
      }
    } finally {
      setRefreshing(false);
    }
  }, [client, settings.useDemoFallback]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const id = window.setInterval(() => {
      void refresh();
    }, settings.pollMs);
    return () => window.clearInterval(id);
  }, [refresh, settings.pollMs]);

  useEffect(() => {
    sseRef.current?.close();
    sseRef.current = null;
    if (connection !== "online") return;

    const sub = client.subscribeEvents({
      onEvent: (evt) => {
        setEvents((prev) => [evt, ...prev].slice(0, 200));
      },
      onError: () => {
        // keep polling; SSE optional
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
    if (events.length === 0 && boardSource === "demo") {
      setEvents(client.getDemoEvents());
    }
  }, [boardSource, client, events.length]);

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
