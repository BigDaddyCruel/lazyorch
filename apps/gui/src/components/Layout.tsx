import type { ReactNode } from "react";
import { countPendingGatesAcrossRuns } from "../lib/gates.js";
import { useAppState, type PageId } from "../state/AppState.js";
import { ConnectionStatus } from "./ConnectionStatus.js";
import { GatesBadge } from "./GatesBadge.js";

const NAV: Array<{ id: PageId; label: string }> = [
  { id: "home", label: "Home" },
  { id: "board", label: "Run board" },
  { id: "plan", label: "Plan" },
  { id: "agents", label: "Agents" },
  { id: "logs", label: "Logs" },
  { id: "settings", label: "Settings" },
];

export function Layout({ children }: { children: ReactNode }) {
  const { page, setPage, connection, settings, runs, health, boardSource, refresh, refreshing } =
    useAppState();
  const pendingGates = countPendingGatesAcrossRuns(runs);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">LO</div>
          <div>
            <h1>LazyOrch</h1>
            <small>Windows GUI MVP</small>
          </div>
        </div>
        <nav className="nav" aria-label="Primary">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`nav-btn ${page === item.id ? "active" : ""}`}
              onClick={() => setPage(item.id)}
            >
              <span>{item.label}</span>
              {item.id === "board" || item.id === "home" ? (
                <GatesBadge count={pendingGates} />
              ) : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <ConnectionStatus connection={connection} baseUrl={settings.daemonUrl} />
          {health && (
            <span className="mono">
              api v{health.api_major} · :{health.port}
            </span>
          )}
          {boardSource && boardSource !== "daemon" && (
            <span className="tag warn">data: {boardSource}</span>
          )}
          {pendingGates > 0 && <span className="tag warn">{pendingGates} gate(s) pending</span>}
        </div>
      </aside>
      <main className="main">
        <div className="topbar">
          <h2>{NAV.find((n) => n.id === page)?.label ?? "LazyOrch"}</h2>
          <div className="topbar-meta">
            {pendingGates > 0 && (
              <span className="pill warn">
                <span className="dot" />
                {pendingGates} pending gate{pendingGates === 1 ? "" : "s"}
              </span>
            )}
            <button
              type="button"
              className="btn"
              onClick={() => void refresh()}
              disabled={refreshing}
            >
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>
        {children}
      </main>
    </div>
  );
}
