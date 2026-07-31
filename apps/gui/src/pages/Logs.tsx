import { formatTs } from "../lib/format.js";
import { useAppState } from "../state/AppState.js";

export function LogsPage() {
  const { events, connection, boardSource, sseState } = useAppState();

  const sseLabel =
    connection !== "online"
      ? connection === "unauthorized"
        ? "auth required"
        : "offline / demo"
      : sseState === "live"
        ? "SSE live"
        : sseState === "reconnecting"
          ? "SSE reconnecting…"
          : sseState === "connecting"
            ? "SSE connecting…"
            : "SSE off";

  return (
    <div className="stack">
      <section className="card">
        <div className="card-header">
          <h3>Event stream</h3>
          <span
            className={`tag ${
              sseState === "live" ? "ok" : sseState === "reconnecting" ? "warn" : "info"
            }`}
          >
            {sseLabel}
          </span>
        </div>
        <p className="muted" style={{ marginTop: 0, fontSize: "0.85rem" }}>
          Live events from <span className="mono">GET /v1/events</span> when authenticated.
          Automatic reconnect with backoff after stream EOF. Demo events seed only when offline +
          demo fallback{boardSource ? ` (source: ${boardSource})` : ""}.
        </p>
        {events.length === 0 ? (
          <p className="empty">No events yet.</p>
        ) : (
          <div className="log-stream" role="log" aria-live="polite">
            {events.map((e, i) => (
              <div key={`${e.id}-${i}`} className="log-line">
                <span className="muted">{formatTs(e.ts)}</span>{" "}
                <span className="tag info">{e.type}</span>{" "}
                {e.run_id && <span className="mono">{e.run_id}</span>}{" "}
                {e.payload && <span className="muted">{JSON.stringify(e.payload)}</span>}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
