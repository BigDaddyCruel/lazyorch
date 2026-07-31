import type { AdapterInfo } from "../api/types.js";
import { healthLabel } from "../lib/format.js";

function toneFor(health: string): string {
  switch (health) {
    case "ok":
      return "ok";
    case "degraded":
      return "warn";
    case "error":
    case "missing":
      return "err";
    default:
      return "info";
  }
}

export function AdapterHealthPanel({ adapters }: { adapters: AdapterInfo[] }) {
  if (adapters.length === 0) {
    return <p className="empty">No adapters reported. Start the daemon or enable demo data.</p>;
  }

  return (
    <table className="table">
      <thead>
        <tr>
          <th>Adapter</th>
          <th>Source</th>
          <th>Health</th>
          <th>Capabilities</th>
        </tr>
      </thead>
      <tbody>
        {adapters.map((a) => {
          const h = healthLabel(a.health);
          return (
            <tr key={a.id}>
              <td className="mono">{a.id}</td>
              <td>{a.source}</td>
              <td>
                <span className={`tag ${toneFor(h)}`}>{h}</span>
              </td>
              <td className="muted">
                {a.capabilities?.models ? "models " : ""}
                {a.capabilities?.cancel ? "cancel" : ""}
                {!a.capabilities?.models && !a.capabilities?.cancel ? "—" : ""}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
