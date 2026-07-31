import { formatTs } from "../lib/format.js";
import { useAppState } from "../state/AppState.js";

export function LogsPage() {
  const { events, connection, boardSource } = useAppState();

  return (
    <div className="stack">
      <section className="card">
        <div className="card-header">
          <h3>Event stream</h3>
          <span className="tag info">
            {connection === "online" ? "SSE /v1/events" : "offline / demo"}
          </span>
        </div>
        <p className="muted" style={{ marginTop: 0, fontSize: "0.85rem" }}>
          Live events from the daemon when online. Demo events seed the view when using fallback
          data{boardSource ? ` (source: ${boardSource})` : ""}.
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
                {e.payload && (
                  <span className="muted">{JSON.stringify(e.payload)}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
