import { AdapterHealthPanel } from "../components/AdapterHealth.js";
import { ModelTierDisplay } from "../components/ModelTierDisplay.js";
import { useAppState } from "../state/AppState.js";

export function AgentsPage() {
  const {
    runs,
    selectedRun,
    selectedRunId,
    setSelectedRunId,
    adapters,
    modelRoute,
  } = useAppState();
  const run = selectedRun ?? runs[0] ?? null;
  const agents = run?.agents ?? [];

  return (
    <div className="stack">
      <section className="card">
        <div className="card-header">
          <h3>Run</h3>
        </div>
        {runs.length === 0 ? (
          <p className="empty">No runs.</p>
        ) : (
          <select
            className="run-select"
            value={selectedRunId ?? run?.id ?? ""}
            onChange={(e) => setSelectedRunId(e.target.value)}
          >
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.idea || r.id}
              </option>
            ))}
          </select>
        )}
      </section>

      <section className="card">
        <h3>Agents</h3>
        {agents.length === 0 ? (
          <p className="empty">No agents for this run.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Role</th>
                <th>Labels</th>
                <th>Session</th>
                <th>Tier</th>
                <th>Adapter / model</th>
                <th>Preferred</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.id}>
                  <td className="mono">{a.id}</td>
                  <td>
                    <span className="tag info">{a.role}</span>
                  </td>
                  <td>{a.labels.join(", ") || "—"}</td>
                  <td>
                    <span
                      className={`tag ${
                        a.session_status === "running"
                          ? "ok"
                          : a.session_status === "error"
                            ? "err"
                            : "info"
                      }`}
                    >
                      {a.session_status ?? "—"}
                    </span>
                  </td>
                  <td>{a.last_model_tier ?? a.default_tier ?? "—"}</td>
                  <td className="mono">
                    {a.last_adapter_id ?? "—"}
                    {a.last_model_id ? ` / ${a.last_model_id}` : ""}
                  </td>
                  <td className="muted">{a.preferred_adapters.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div className="grid-2">
        <section className="card">
          <h3>Adapter health</h3>
          <AdapterHealthPanel adapters={adapters} />
        </section>
        <section className="card">
          <h3>Model / tier display</h3>
          <ModelTierDisplay route={modelRoute} />
          <p className="muted" style={{ fontSize: "0.82rem", marginBottom: 0 }}>
            Dry-run from <span className="mono">GET /v1/models/route</span> (daemon stub until
            router is fully exposed).
          </p>
        </section>
      </div>
    </div>
  );
}
