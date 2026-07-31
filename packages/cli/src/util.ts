import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { StateStore, type Gate, type Run } from "@lazyorch/core";

export function stateRoot(repo: string): string {
  return resolve(repo, ".lazyorch");
}

export function createStore(repo: string): StateStore {
  return new StateStore(stateRoot(repo));
}

export function writeJson(
  stdout: NodeJS.WritableStream,
  value: unknown,
  pretty: boolean = true,
): void {
  const text = pretty
    ? `${JSON.stringify(value, null, 2)}\n`
    : `${JSON.stringify(value)}\n`;
  stdout.write(text);
}

export function writeLine(
  stream: NodeJS.WritableStream,
  line: string,
): void {
  stream.write(line.endsWith("\n") ? line : `${line}\n`);
}

/** List run ids under `<root>/runs/*` that have run.json. */
export async function listRunIds(store: StateStore): Promise<string[]> {
  const dir = join(store.root, "runs");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
  const ids: string[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const run = await store.readRun(name);
    if (run) ids.push(run.id);
  }
  ids.sort();
  return ids;
}

export async function listRuns(store: StateStore): Promise<Run[]> {
  const ids = await listRunIds(store);
  const runs: Run[] = [];
  for (const id of ids) {
    const run = await store.readRun(id);
    if (run) runs.push(run);
  }
  return runs;
}

/** Collect gates across all runs (optionally filter by status). */
export async function listAllGates(
  store: StateStore,
  opts?: { status?: string; runId?: string },
): Promise<Array<Gate & { project_run_id?: string }>> {
  const runIds = opts?.runId ? [opts.runId] : await listRunIds(store);
  const out: Gate[] = [];
  for (const runId of runIds) {
    const gates = await store.readGates(runId);
    for (const g of gates) {
      if (opts?.status && g.status !== opts.status) continue;
      out.push(g);
    }
  }
  out.sort((a, b) => {
    if (a.created_at < b.created_at) return -1;
    if (a.created_at > b.created_at) return 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return out;
}

/** Find a gate by id across runs; returns gate + run. */
export async function findGate(
  store: StateStore,
  gateId: string,
  runIdHint?: string,
): Promise<{ gate: Gate; run: Run; gates: Gate[] } | null> {
  const runIds = runIdHint ? [runIdHint] : await listRunIds(store);
  for (const runId of runIds) {
    const gates = await store.readGates(runId);
    const gate = gates.find((g) => g.id === gateId);
    if (!gate) continue;
    const run = await store.readRun(runId);
    if (!run) continue;
    return { gate, run, gates };
  }
  return null;
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}
