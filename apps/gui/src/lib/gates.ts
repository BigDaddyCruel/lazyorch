import type { BoardGate, BoardRun, GateStatus } from "../api/types.js";

export function isPendingGate(gate: BoardGate): boolean {
  return gate.status === "pending";
}

export function countPendingGates(gates: readonly BoardGate[]): number {
  return gates.filter(isPendingGate).length;
}

export function countPendingGatesAcrossRuns(runs: readonly BoardRun[]): number {
  let n = 0;
  for (const run of runs) {
    n += countPendingGates(run.gates ?? []);
  }
  return n;
}

export function collectPendingGates(
  runs: readonly BoardRun[],
): Array<BoardGate & { idea?: string }> {
  const out: Array<BoardGate & { idea?: string }> = [];
  for (const run of runs) {
    for (const g of run.gates ?? []) {
      if (isPendingGate(g)) {
        out.push({ ...g, idea: run.idea });
      }
    }
  }
  return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function gateStatusTone(status: GateStatus | string): "warn" | "ok" | "err" | "muted" {
  switch (status) {
    case "pending":
      return "warn";
    case "approved":
      return "ok";
    case "rejected":
    case "timed_out":
      return "err";
    default:
      return "muted";
  }
}

/** Badge label: empty when zero pending; otherwise count string. */
export function gatesBadgeLabel(pendingCount: number): string | null {
  if (pendingCount <= 0) return null;
  if (pendingCount > 99) return "99+";
  return String(pendingCount);
}
