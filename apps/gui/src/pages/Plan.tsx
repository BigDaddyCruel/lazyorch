import { formatTs } from "../lib/format.js";
import { useAppState } from "../state/AppState.js";

export function PlanPage() {
  const { runs, selectedRun, selectedRunId, setSelectedRunId } = useAppState();
  const run = selectedRun ?? runs[0] ?? null;
  const plan = run?.plan;

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

      {!plan ? (
        <section className="card">
          <p className="empty">
            No plan attached to this run. Planning artifacts will appear here when daemon plan
            endpoints are wired (CLI `lazyorch run show` already reads local plan state).
          </p>
        </section>
      ) : (
        <>
          <section className="card">
            <div className="card-header">
              <h3>Plan {plan.id}</h3>
              <span className="tag info">{plan.status}</span>
            </div>
            <table className="table">
              <tbody>
                <tr>
                  <th>Revision</th>
                  <td>{plan.revision}</td>
                </tr>
                <tr>
                  <th>Tasks</th>
                  <td>{plan.task_ids.length}</td>
                </tr>
                <tr>
                  <th>Updated</th>
                  <td>{formatTs(plan.updated_at)}</td>
                </tr>
                <tr>
                  <th>Freeze hash</th>
                  <td className="mono">{plan.freeze_hash ?? "—"}</td>
                </tr>
              </tbody>
            </table>
            {plan.residual_risks && plan.residual_risks.length > 0 && (
              <>
                <h3 style={{ marginTop: "1rem" }}>Residual risks</h3>
                <ul>
                  {plan.residual_risks.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </>
            )}
          </section>

          <section className="card">
            <h3>Issues</h3>
            {plan.issues.length === 0 ? (
              <p className="empty">No plan issues.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Severity</th>
                    <th>Category</th>
                    <th>Section</th>
                    <th>Status</th>
                    <th>Description</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.issues.map((iss) => (
                    <tr key={iss.id}>
                      <td>
                        <span
                          className={`tag ${
                            iss.severity === "high" || iss.severity === "critical"
                              ? "err"
                              : iss.severity === "medium"
                                ? "warn"
                                : "info"
                          }`}
                        >
                          {iss.severity}
                        </span>
                      </td>
                      <td>{iss.category}</td>
                      <td>{iss.section}</td>
                      <td>{iss.status}</td>
                      <td>{iss.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="card">
            <h3>Plan task ids</h3>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem" }}>
              {plan.task_ids.map((id) => (
                <span key={id} className="tag mono">
                  {id}
                </span>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
