/** Format ISO timestamps for operator display. */
export function formatTs(iso: string | undefined | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function shortId(id: string, head = 12): string {
  if (id.length <= head) return id;
  return `${id.slice(0, head)}…`;
}

export function tierLabel(tier: string | undefined | null): string {
  if (!tier) return "—";
  return tier;
}

export function healthLabel(health: string | undefined | null): string {
  if (!health) return "unknown";
  return health;
}
