import { gatesBadgeLabel } from "../lib/gates.js";

export function GatesBadge({ count }: { count: number }) {
  const label = gatesBadgeLabel(count);
  if (!label) return null;
  return (
    <span
      className="badge"
      title={`${count} pending gate(s)`}
      aria-label={`${count} pending gates`}
    >
      {label}
    </span>
  );
}
