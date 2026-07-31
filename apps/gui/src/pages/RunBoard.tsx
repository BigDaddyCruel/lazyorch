import { PhaseTimeline } from "../components/PhaseTimeline.js";
import { TaskKanban } from "../components/TaskKanban.js";
import { formatTs } from "../lib/format.js";
import { countPendingGates, gateStatusTone } from "../lib/gates.js";
import { taskProgress } from "../lib/kanban.js";
import { phaseTone } from "../lib/phases.js";
import { useAppState } from "../state/AppState.js";

export function RunBoardPage() {
  const { runs, selectedRun, selectedRunId, setSelectedRunId, boardSource } = useAppState();

  if (runs.length === 0) {
    return (
      <div className="card">
        <p className="empty">No runs to display.</p>
      </div>
    );
  }

  const run = selectedRun ?? runs[0]!;
  const progress = taskProgress(run.tasks ?? []);
  const pendingGates = countPendingGates(run.gates ?? []);

  return (
    <div className="stack">
      <section className="card">
        <div className="card-header">
          <h3>Select run</h3>
          {boardSource && boardSource !== "daemon" && (
            <span className="tag warn">board source: {boardSource}</span>
          )}
        </div>
        <select
          className="run-select"
          value={selectedRunId ?? run.id}
          onChange={(e) => setSelectedRunId(e.target.value)}
        >
          {runs.map((r) => (
            <option key={r.id} value={r.id}>
              [{r.phase}] {r.idea || r.id}
            </option>
          ))}
        </select>
      </section>

      <section className="card">
        <div className="card-header">
          <h3>Run phases</h3>
          <span className={`tag ${phaseTone(run.phase)}`}>{run.phase}</span>
        </div>
        <p className="muted" style={{ marginTop: 0 }}>
          <span className="mono">{run.id}</span>
          {run.feature_branch ? (
            <>
              {" "}
              · branch <span className="mono">{run.feature_branch}</span>
            </>
          ) : null}
        </p>
        <p>{run.idea}</p>
        <PhaseTimeline phase={run.phase} />
        <div className="stat-row" style={{ marginTop: "1rem" }}>
          <div className="stat">
            <div className="label">Tasks done</div>
            <div className="value">
              {progress.done}/{progress.total}
            </div>
          </div>
          <div className="stat">
            <div className="label">Active</div>
            <div className="value">{progress.active}</div>
          </div>
          <div className="stat">
            <div className="label">Failed</div>
            <div className="value">{progress.failed}</div>
          </div>
          <div className="stat">
            <div className="label">Pending gates</div>
            <div className="value" style={{ color: pendingGates ? "var(--warn)" : undefined }}>
              {pendingGates}
            </div>
          </div>
        </div>
      </section>

      <section className="card">
        <h3>Task kanban</h3>
        <TaskKanban tasks={run.tasks ?? []} />
      </section>

      <section className="card">
        <div className="card-header">
          <h3>Gates</h3>
          {pendingGates > 0 && <span className="tag warn">{pendingGates} pending</span>}
        </div>
        {(run.gates ?? []).length === 0 ? (
          <p className="empty">No gates on this run.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Type</th>
                <th>Status</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {(run.gates ?? []).map((g) => (
                <tr key={g.id}>
                  <td className="mono">{g.id}</td>
                  <td>{g.type}</td>
                  <td>
                    <span className={`tag ${gateStatusTone(g.status)}`}>{g.status}</span>
                  </td>
                  <td>{formatTs(g.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted" style={{ marginBottom: 0, marginTop: "0.75rem", fontSize: "0.82rem" }}>
          Approve/reject remains CLI-first (`lazyorch gate`) until daemon gate HTTP lands. This
          panel is read-only visibility.
        </p>
      </section>
    </div>
  );
}
