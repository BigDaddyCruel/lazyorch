import type { ModelRouteResponse } from "../api/types.js";
import { tierLabel } from "../lib/format.js";

export function ModelTierDisplay({ route }: { route: ModelRouteResponse | null }) {
  if (!route) {
    return <p className="empty">No routing decision yet.</p>;
  }

  return (
    <div className="stat-row">
      <div className="stat">
        <div className="label">Tier</div>
        <div className="value">{tierLabel(route.tier)}</div>
      </div>
      <div className="stat">
        <div className="label">Adapter</div>
        <div className="value mono" style={{ fontSize: "1.05rem" }}>
          {route.adapter_id}
        </div>
      </div>
      <div className="stat">
        <div className="label">Model</div>
        <div className="value mono" style={{ fontSize: "1.05rem" }}>
          {route.model}
        </div>
      </div>
      <div className="stat">
        <div className="label">Role / reason</div>
        <div className="value" style={{ fontSize: "0.95rem" }}>
          {route.role}
          <div className="muted" style={{ fontSize: "0.78rem", fontWeight: 400 }}>
            {route.reason}
            {route.stub ? " (stub)" : ""}
          </div>
        </div>
      </div>
    </div>
  );
}
