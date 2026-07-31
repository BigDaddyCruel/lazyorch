/**
 * `lazyorch run list|show` — list runs / show run detail (+ gates, tasks, plan).
 *
 * Observational: default exit 0 even when gates are pending.
 * Opt-in exit 3 with `--check` / `check: true`.
 */
import { resolve } from "node:path";
import type { Gate, Plan, Run, Task } from "@lazyorch/core";
import { EXIT } from "../exit-codes.js";
import { createStore, listRuns, writeJson } from "../util.js";

export type RunSubcommand = "list" | "show";

export interface RunCommandOptions {
  action: RunSubcommand;
  /** Run id for show. */
  runId?: string;
  repo?: string;
  /**
   * When true, show exits 3 if pending gates (default false).
   * CLI flag: --check / --gate-exit
   */
  check?: boolean;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  pretty?: boolean;
}

export interface RunCommandResult {
  exitCode: number;
  action: RunSubcommand;
  runs?: Run[];
  run?: Run;
  gates?: Gate[];
  tasks?: Task[];
  plan?: Plan | null;
  message?: string;
}

export async function runRunCommand(
  options: RunCommandOptions,
): Promise<RunCommandResult> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const pretty = options.pretty !== false;
  const repo = resolve(options.repo ?? process.cwd());
  const store = createStore(repo);

  switch (options.action) {
    case "list": {
      const runs = await listRuns(store);
      writeJson(
        stdout,
        {
          repo,
          runs: runs.map((r) => ({
            id: r.id,
            phase: r.phase,
            idea: r.idea,
            project_id: r.project_id,
            created_at: r.created_at,
            updated_at: r.updated_at,
          })),
        },
        pretty,
      );
      return { exitCode: EXIT.OK, action: "list", runs };
    }
    case "show": {
      const runId = options.runId?.trim() ?? "";
      if (!runId) {
        stderr.write("error: run show requires <run_id>\n");
        return { exitCode: EXIT.USAGE, action: "show", message: "missing run" };
      }
      const run = await store.readRun(runId);
      if (!run) {
        stderr.write(`error: run not found: ${runId}\n`);
        return {
          exitCode: EXIT.ERROR,
          action: "show",
          message: "run_not_found",
        };
      }
      const gates = await store.readGates(runId);
      const tasks = await store.listTasks(runId);
      const plan = await store.readPlan(runId);
      const pending = gates.filter((g) => g.status === "pending");

      writeJson(
        stdout,
        {
          run,
          gates,
          tasks,
          plan: plan ?? null,
          pending_gate_count: pending.length,
        },
        pretty,
      );

      if (options.check === true && pending.length > 0) {
        return {
          exitCode: EXIT.GATE,
          action: "show",
          run,
          gates,
          tasks,
          plan,
          message: "gate_pending",
        };
      }
      return {
        exitCode: EXIT.OK,
        action: "show",
        run,
        gates,
        tasks,
        plan,
      };
    }
    default: {
      stderr.write("error: run requires list|show\n");
      return { exitCode: EXIT.USAGE, action: options.action, message: "usage" };
    }
  }
}
