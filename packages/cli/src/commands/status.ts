/**
 * `lazyorch status [run_id]` — overview of local runs + pending gates.
 *
 * Observational: default exit 0 even when gates are pending.
 * Opt-in exit 3 with `--gate-exit` / `gateExit: true` (CI check).
 */
import { resolve } from "node:path";
import type { Gate, Run } from "@lazyorch/core";
import { EXIT } from "../exit-codes.js";
import {
  createStore,
  listAllGates,
  listRuns,
  writeJson,
} from "../util.js";

export interface StatusOptions {
  /** Optional run id (positional). */
  runId?: string;
  repo?: string;
  /**
   * When true, exit 3 if any pending gates (default false — observational).
   * CLI flag: --gate-exit / --check
   */
  gateExit?: boolean;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  pretty?: boolean;
  /**
   * Optional daemon status probe (inject for tests).
   * Return null when daemon unavailable.
   */
  daemonStatus?: () => Promise<DaemonStatusSnapshot | null>;
}

export interface DaemonStatusSnapshot {
  url: string;
  ok: boolean;
  project_count?: number;
  run_count?: number;
  started_at?: string;
}

export interface StatusResult {
  exitCode: number;
  runs: Run[];
  pendingGates: Gate[];
  daemon?: DaemonStatusSnapshot | null;
  message?: string;
}

/**
 * Show run status and pending gates for the local project.
 */
export async function runStatus(
  options: StatusOptions = {},
): Promise<StatusResult> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const pretty = options.pretty !== false;
  const repo = resolve(options.repo ?? process.cwd());
  const store = createStore(repo);

  let runs: Run[];
  if (options.runId) {
    const run = await store.readRun(options.runId);
    if (!run) {
      stderr.write(`error: run not found: ${options.runId}\n`);
      return {
        exitCode: EXIT.ERROR,
        runs: [],
        pendingGates: [],
        message: "run_not_found",
      };
    }
    runs = [run];
  } else {
    runs = await listRuns(store);
  }

  const pendingGates = await listAllGates(store, {
    status: "pending",
    ...(options.runId ? { runId: options.runId } : {}),
  });

  let daemon: DaemonStatusSnapshot | null = null;
  if (options.daemonStatus) {
    try {
      daemon = await options.daemonStatus();
    } catch {
      daemon = null;
    }
  }

  const payload = {
    repo,
    run_count: runs.length,
    runs: runs.map((r) => ({
      id: r.id,
      phase: r.phase,
      idea: r.idea.length > 80 ? `${r.idea.slice(0, 77)}...` : r.idea,
      project_id: r.project_id,
      updated_at: r.updated_at,
      plan_id: r.plan_id ?? null,
      pr: r.pr_ref ?? null,
    })),
    pending_gates: pendingGates.map((g) => ({
      id: g.id,
      type: g.type,
      run_id: g.run_id,
      status: g.status,
      created_at: g.created_at,
      timeout_at: g.timeout_at ?? null,
    })),
    daemon: daemon
      ? {
          url: daemon.url,
          ok: daemon.ok,
          project_count: daemon.project_count ?? null,
          run_count: daemon.run_count ?? null,
          started_at: daemon.started_at ?? null,
        }
      : null,
  };

  writeJson(stdout, payload, pretty);

  // Exit 3 only when explicitly requested (--gate-exit / --check).
  if (options.gateExit === true && pendingGates.length > 0) {
    return {
      exitCode: EXIT.GATE,
      runs,
      pendingGates,
      daemon,
      message: "gate_pending",
    };
  }

  return { exitCode: EXIT.OK, runs, pendingGates, daemon };
}
