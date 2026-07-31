import { AdapterHealthPanel } from "../components/AdapterHealth.js";
import { ModelTierDisplay } from "../components/ModelTierDisplay.js";
import { formatTs } from "../lib/format.js";
import { collectPendingGates, countPendingGatesAcrossRuns } from "../lib/gates.js";
import { phaseTone } from "../lib/phases.js";
import { useAppState } from "../state/AppState.js";

export function HomePage() {
  const {
    connection,
    health,
    status,
    projects,
    adapters,
    modelRoute,
    runs,
    boardSource,
    lastError,
    setPage,
    setSelectedRunId,
  } = useAppState();

  const pending = countPendingGatesAcrossRuns(runs);
  const pendingList = collectPendingGates(runs);

  return (
    <div className="stack">
      {connection === "unauthorized" && (
        <div className="alert warn">
          {lastError ?? "Authentication required."} Open{" "}
          <button type="button" className="btn" onClick={() => setPage("settings")}>
            Settings
          </button>{" "}
          and paste the daemon Bearer token. Demo board data is <strong>not</strong> shown while
          unauthorized so live daemon state is never masked.
        </div>
      )}
      {lastError && connection === "offline" && (
        <div className="alert warn">
          Daemon unreachable ({lastError}).{" "}
          {boardSource === "demo"
            ? "Showing demo board data — start `lazyorch serve` or set URL/token in Settings."
            : "Check Settings for daemon URL and Bearer token."}
        </div>
      )}

      <div className="stat-row">
        <div className="stat">
          <div className="label">Connection</div>
          <div className="value" style={{ fontSize: "1.1rem" }}>
            {connection}
          </div>
        </div>
        <div className="stat">
          <div className="label">Projects</div>
          <div className="value">{status?.project_count ?? projects.length}</div>
        </div>
        <div className="stat">
          <div className="label">Runs</div>
          <div className="value">{runs.length}</div>
        </div>
        <div className="stat">
          <div className="label">Pending gates</div>
          <div className="value" style={{ color: pending ? "var(--warn)" : undefined }}>
            {pending}
          </div>
        </div>
      </div>

      <div className="grid-2">
        <section className="card">
          <div className="card-header">
            <h3>Daemon</h3>
            {health && <span className="tag ok">{health.status}</span>}
          </div>
          {health ? (
            <table className="table">
              <tbody>
                <tr>
                  <th>Host</th>
                  <td className="mono">
                    {health.host}:{health.port}
                  </td>
                </tr>
                <tr>
                  <th>API major</th>
                  <td>{health.api_major}</td>
                </tr>
                <tr>
                  <th>PID</th>
                  <td className="mono">{health.pid}</td>
                </tr>
                <tr>
                  <th>Started</th>
                  <td>{formatTs(health.started_at)}</td>
                </tr>
              </tbody>
            </table>
          ) : (
            <p className="empty">No health payload.</p>
          )}
        </section>

        <section className="card">
          <div className="card-header">
            <h3>Pending gates</h3>
            <button type="button" className="btn" onClick={() => setPage("board")}>
              Open board
            </button>
          </div>
          {pendingList.length === 0 ? (
            <p className="empty">No pending gates.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Gate</th>
                  <th>Type</th>
                  <th>Run</th>
                </tr>
              </thead>
              <tbody>
                {pendingList.map((g) => (
                  <tr key={g.id}>
                    <td className="mono">{g.id}</td>
                    <td>
                      <span className="tag warn">{g.type}</span>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => {
                          setSelectedRunId(g.run_id);
                          setPage("board");
                        }}
                      >
                        {g.idea ? g.idea.slice(0, 40) : g.run_id}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <section className="card">
        <div className="card-header">
          <h3>Runs</h3>
          {boardSource && <span className="tag info">source: {boardSource}</span>}
        </div>
        {runs.length === 0 ? (
          <p className="empty">No runs. Use CLI `lazyorch start` or enable demo data.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Phase</th>
                <th>Idea</th>
                <th>Gates</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const pg = (r.gates ?? []).filter((g) => g.status === "pending").length;
                return (
                  <tr key={r.id}>
                    <td className="mono">{r.id}</td>
                    <td>
                      <span className={`tag ${phaseTone(r.phase)}`}>{r.phase}</span>
                    </td>
                    <td>{r.idea || "—"}</td>
                    <td>{pg > 0 ? <span className="tag warn">{pg}</span> : "0"}</td>
                    <td>
                      <button
                        type="button"
                        className="btn primary"
                        onClick={() => {
                          setSelectedRunId(r.id);
                          setPage("board");
                        }}
                      >
                        Board
                      </button>
                    </td>
                  </tr>
                );
              })}
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
          <h3>Model / tier (dry-run route)</h3>
          <ModelTierDisplay route={modelRoute} />
        </section>
      </div>

      <section className="card">
        <h3>Projects</h3>
        {projects.length === 0 ? (
          <p className="empty">No registered projects.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Name</th>
                <th>Root</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id}>
                  <td className="mono">{p.id}</td>
                  <td>{p.name ?? "—"}</td>
                  <td className="mono">{p.repo_root}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
