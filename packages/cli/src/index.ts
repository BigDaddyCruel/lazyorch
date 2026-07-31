#!/usr/bin/env node
/**
 * @lazyorch/cli — lazyorch command-line interface.
 */
import { parseArgs } from "node:util";
import { runInit } from "./commands/init.js";
import { runDoctor } from "./commands/doctor.js";
import { runContext, type ContextSubcommand } from "./commands/context.js";
import { runAdapter, type AdapterSubcommand } from "./commands/adapter.js";
import { runStart } from "./commands/start.js";
import { runStatus } from "./commands/status.js";
import { runRunCommand, type RunSubcommand } from "./commands/run.js";
import { runGate, type GateSubcommand } from "./commands/gate.js";
import { runModels, type ModelsSubcommand } from "./commands/models.js";
import { runLogs } from "./commands/logs.js";
import { runServe } from "./commands/serve.js";
import { EXIT } from "./exit-codes.js";

export const PACKAGE_NAME = "@lazyorch/cli" as const;

export function cliPlaceholder(): string {
  return PACKAGE_NAME;
}

export { EXIT } from "./exit-codes.js";
export { runInit, type InitOptions, type InitResult } from "./commands/init.js";
export {
  runDoctor,
  type DoctorOptions,
  type DoctorResult,
  type DoctorFinding,
} from "./commands/doctor.js";
export {
  runContext,
  type ContextOptions,
  type ContextResult,
  type ContextSubcommand,
} from "./commands/context.js";
export {
  runAdapter,
  type AdapterCommandOptions,
  type AdapterCommandResult,
  type AdapterSubcommand,
} from "./commands/adapter.js";
export {
  runStart,
  type StartOptions,
  type StartResult,
} from "./commands/start.js";
export {
  runStatus,
  type StatusOptions,
  type StatusResult,
} from "./commands/status.js";
export {
  runRunCommand,
  type RunCommandOptions,
  type RunCommandResult,
  type RunSubcommand,
} from "./commands/run.js";
export {
  runGate,
  type GateCommandOptions,
  type GateCommandResult,
  type GateSubcommand,
} from "./commands/gate.js";
export {
  runModels,
  type ModelsCommandOptions,
  type ModelsCommandResult,
  type ModelsSubcommand,
} from "./commands/models.js";
export {
  runLogs,
  type LogsOptions,
  type LogsResult,
} from "./commands/logs.js";
export {
  runServe,
  type ServeCommandOptions,
  type ServeCommandResult,
} from "./commands/serve.js";

const HELP = `lazyorch — AI agent orchestration CLI

Usage:
  lazyorch <command> [options]

Commands:
  init      Create .lazyorch/config.yml and project.json skeleton
  doctor    Validate config, slot packing, and adapter binaries
  serve     Ensure user-level daemon is running
  start     Create a run from an idea
  status    Show runs + pending gates [run_id]
  run       Run list|show
  gate      Gate list|approve|reject
  models    Model router dry-run (route)
  adapter   Adapter registry (list|register|test)
  context   Shared run context KV (list|get|set|delete)
  logs      Read events JSONL
  help      Show this help

Exit codes:
  0 ok  1 error  2 usage  3 gate required  4 adapter missing
  5 plan not consensus/validators  6 multi-PR not implemented

serve:
  lazyorch serve [--port n] [--host addr] [--home dir] [--background] [--once]

start:
  lazyorch start "<idea>" [-f idea.md] [--budget-usd n] [--yes]
    [--tier t] [--model m] [--adapter a] [--repo path]

status:
  lazyorch status [run_id] [--repo path] [--gate-exit]

run:
  lazyorch run list [--repo path]
  lazyorch run show <run_id> [--repo path]

gate:
  lazyorch gate list [--run id] [--all] [--check] [--repo path]
  lazyorch gate approve <gate_id> [--run id] [--decision action]
  lazyorch gate reject <gate_id> [--run id] [--decision action]

models:
  lazyorch models route [--role worker] [--task id] [--signals json]
    [--tier t] [--model m] [--adapter a] [--budget-pressure]

logs:
  lazyorch logs [--run id] [--follow] [--limit n] [--repo path]

adapter / context / init / doctor: see prior help sections (unchanged).
`;

const CONTEXT_ACTIONS = new Set<string>(["list", "get", "set", "delete"]);
const ADAPTER_ACTIONS = new Set<string>(["list", "register", "test"]);
const GATE_ACTIONS = new Set<string>(["list", "approve", "reject"]);
const RUN_ACTIONS = new Set<string>(["list", "show"]);
const MODELS_ACTIONS = new Set<string>(["route"]);

async function main(argv: string[]): Promise<number> {
  let values: Record<string, unknown>;
  let positionals: string[];

  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        name: { type: "string" },
        repo: { type: "string" },
        run: { type: "string" },
        id: { type: "string" },
        binary: { type: "string" },
        "start-template": { type: "string" },
        "models-args": { type: "string" },
        "from-template": { type: "string" },
        capabilities: { type: "string" },
        enabled: { type: "boolean", default: false },
        probe: { type: "boolean", default: false },
        "skip-probe": { type: "boolean", default: false },
        force: { type: "boolean", default: false },
        ci: { type: "boolean", default: false },
        "no-ci": { type: "boolean", default: false },
        // start / models / serve
        f: { type: "string", short: "f" },
        "budget-usd": { type: "string" },
        yes: { type: "boolean", default: false },
        tier: { type: "string" },
        model: { type: "string" },
        adapter: { type: "string" },
        role: { type: "string" },
        task: { type: "string" },
        signals: { type: "string" },
        "budget-pressure": { type: "boolean", default: false },
        // gate
        all: { type: "boolean", default: false },
        check: { type: "boolean", default: false },
        decision: { type: "string" },
        "gate-exit": { type: "boolean", default: false },
        // logs / serve
        follow: { type: "boolean", default: false },
        limit: { type: "string" },
        port: { type: "string" },
        host: { type: "string" },
        home: { type: "string" },
        background: { type: "boolean", default: false },
        once: { type: "boolean", default: false },
        help: { type: "boolean", default: false, short: "h" },
        version: { type: "boolean", default: false, short: "v" },
      },
      allowPositionals: true,
      strict: true,
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${msg}\n\n${HELP}`);
    return EXIT.USAGE;
  }

  if (values.help === true || positionals[0] === "help") {
    process.stdout.write(HELP);
    return EXIT.OK;
  }

  if (values.version === true) {
    process.stdout.write("lazyorch 0.0.0\n");
    return EXIT.OK;
  }

  const command = positionals[0];
  if (!command) {
    process.stdout.write(HELP);
    return EXIT.OK;
  }

  switch (command) {
    case "init": {
      const initOpts: Parameters<typeof runInit>[0] = {
        force: values.force === true,
      };
      if (typeof values.name === "string") initOpts.name = values.name;
      if (typeof values.repo === "string") initOpts.repo = values.repo;
      await runInit(initOpts);
      return EXIT.OK;
    }
    case "doctor": {
      const doctorOpts: Parameters<typeof runDoctor>[0] = {};
      if (typeof values.repo === "string") doctorOpts.repo = values.repo;
      if (values["no-ci"] === true) {
        doctorOpts.ci = false;
      } else if (values.ci === true) {
        doctorOpts.ci = true;
      }
      const result = await runDoctor(doctorOpts);
      return result.exitCode;
    }
    case "serve": {
      const serveOpts: Parameters<typeof runServe>[0] = {
        background: values.background === true,
        once: values.once === true || values.background === true,
      };
      if (typeof values.port === "string") {
        const n = Number(values.port);
        if (!Number.isInteger(n) || n < 0) {
          process.stderr.write("error: --port must be a non-negative integer\n");
          return EXIT.USAGE;
        }
        serveOpts.port = n;
      }
      if (typeof values.host === "string") serveOpts.host = values.host;
      if (typeof values.home === "string") serveOpts.home = values.home;
      // Foreground without --once keeps process alive (daemon owns HTTP).
      const result = await runServe(serveOpts);
      return result.exitCode;
    }
    case "start": {
      const startOpts: Parameters<typeof runStart>[0] = {
        yes: values.yes === true,
      };
      // idea: positional after command, or -f file
      if (typeof positionals[1] === "string") startOpts.idea = positionals[1];
      if (typeof values.f === "string") startOpts.ideaFile = values.f;
      if (typeof values.repo === "string") startOpts.repo = values.repo;
      if (typeof values.tier === "string") startOpts.tier = values.tier;
      if (typeof values.model === "string") startOpts.model = values.model;
      if (typeof values.adapter === "string") startOpts.adapter = values.adapter;
      if (typeof values["budget-usd"] === "string") {
        const n = Number(values["budget-usd"]);
        if (!Number.isFinite(n) || n < 0) {
          process.stderr.write("error: --budget-usd must be a non-negative number\n");
          return EXIT.USAGE;
        }
        startOpts.budgetUsd = n;
      }
      const result = await runStart(startOpts);
      return result.exitCode;
    }
    case "status": {
      const statusOpts: Parameters<typeof runStatus>[0] = {};
      if (typeof positionals[1] === "string") statusOpts.runId = positionals[1];
      if (typeof values.repo === "string") statusOpts.repo = values.repo;
      if (values["gate-exit"] === true) statusOpts.gateExit = true;
      const result = await runStatus(statusOpts);
      return result.exitCode;
    }
    case "run":
    case "runs": {
      const actionRaw = positionals[1];
      if (!actionRaw || !RUN_ACTIONS.has(actionRaw)) {
        process.stderr.write(
          `error: run requires list|show\n\n${HELP}`,
        );
        return EXIT.USAGE;
      }
      const runOpts: Parameters<typeof runRunCommand>[0] = {
        action: actionRaw as RunSubcommand,
      };
      if (typeof values.repo === "string") runOpts.repo = values.repo;
      if (actionRaw === "show") {
        if (typeof positionals[2] === "string") runOpts.runId = positionals[2];
        else if (typeof values.run === "string") runOpts.runId = values.run;
      }
      const result = await runRunCommand(runOpts);
      return result.exitCode;
    }
    case "gate": {
      const actionRaw = positionals[1];
      if (!actionRaw || !GATE_ACTIONS.has(actionRaw)) {
        process.stderr.write(
          `error: gate requires list|approve|reject\n\n${HELP}`,
        );
        return EXIT.USAGE;
      }
      const gateOpts: Parameters<typeof runGate>[0] = {
        action: actionRaw as GateSubcommand,
      };
      if (typeof values.repo === "string") gateOpts.repo = values.repo;
      if (typeof values.run === "string") gateOpts.run = values.run;
      if (values.all === true) gateOpts.all = true;
      if (values.check === true) gateOpts.check = true;
      if (typeof values.decision === "string") {
        gateOpts.decision = values.decision;
      }
      if (actionRaw === "approve" || actionRaw === "reject") {
        if (typeof positionals[2] === "string") {
          gateOpts.gateId = positionals[2];
        } else if (typeof values.id === "string") {
          gateOpts.gateId = values.id;
        }
      }
      const result = await runGate(gateOpts);
      return result.exitCode;
    }
    case "models": {
      const actionRaw = positionals[1];
      if (!actionRaw || !MODELS_ACTIONS.has(actionRaw)) {
        process.stderr.write(
          `error: models requires route\n\n${HELP}`,
        );
        return EXIT.USAGE;
      }
      const modelsOpts: Parameters<typeof runModels>[0] = {
        action: actionRaw as ModelsSubcommand,
      };
      if (typeof values.repo === "string") modelsOpts.repo = values.repo;
      if (typeof values.role === "string") modelsOpts.role = values.role;
      if (typeof values.task === "string") modelsOpts.task = values.task;
      if (typeof values.signals === "string") {
        modelsOpts.signalsJson = values.signals;
      }
      if (typeof values.tier === "string") modelsOpts.tier = values.tier;
      if (typeof values.model === "string") modelsOpts.model = values.model;
      if (typeof values.adapter === "string") modelsOpts.adapter = values.adapter;
      if (values["budget-pressure"] === true) modelsOpts.budgetPressure = true;
      const result = await runModels(modelsOpts);
      return result.exitCode;
    }
    case "logs": {
      const logsOpts: Parameters<typeof runLogs>[0] = {
        follow: values.follow === true,
      };
      if (typeof values.run === "string") logsOpts.run = values.run;
      if (typeof values.repo === "string") logsOpts.repo = values.repo;
      if (typeof values.limit === "string") {
        const n = Number(values.limit);
        if (!Number.isInteger(n) || n < 0) {
          process.stderr.write("error: --limit must be a non-negative integer\n");
          return EXIT.USAGE;
        }
        logsOpts.limit = n;
      }
      const result = await runLogs(logsOpts);
      return result.exitCode;
    }
    case "adapter": {
      const actionRaw = positionals[1];
      if (!actionRaw || !ADAPTER_ACTIONS.has(actionRaw)) {
        process.stderr.write(
          `error: adapter requires list|register|test\n\n${HELP}`,
        );
        return EXIT.USAGE;
      }
      const action = actionRaw as AdapterSubcommand;
      const adapterOpts: Parameters<typeof runAdapter>[0] = { action };
      if (typeof values.repo === "string") adapterOpts.repo = values.repo;
      if (typeof values.id === "string") adapterOpts.id = values.id;
      if (typeof values.binary === "string") adapterOpts.binary = values.binary;
      if (typeof values.name === "string") adapterOpts.displayName = values.name;
      if (typeof values["start-template"] === "string") {
        adapterOpts.startTemplate = values["start-template"];
      }
      if (typeof values["models-args"] === "string") {
        adapterOpts.modelsArgs = values["models-args"];
      }
      if (typeof values["from-template"] === "string") {
        adapterOpts.fromTemplate = values["from-template"];
      }
      if (typeof values.capabilities === "string") {
        adapterOpts.capabilitiesJson = values.capabilities;
      }
      if (values.enabled === true) adapterOpts.enabledOnly = true;
      if (values.probe === true) adapterOpts.probe = true;
      if (values["skip-probe"] === true) adapterOpts.skipProbe = true;
      if (action === "test" && typeof positionals[2] === "string") {
        adapterOpts.id = positionals[2];
      }
      if (action === "register" && !adapterOpts.id && typeof positionals[2] === "string") {
        adapterOpts.id = positionals[2];
      }
      const result = await runAdapter(adapterOpts);
      return result.exitCode;
    }
    case "context": {
      const actionRaw = positionals[1];
      if (!actionRaw || !CONTEXT_ACTIONS.has(actionRaw)) {
        process.stderr.write(
          `error: context requires list|get|set|delete\n\n${HELP}`,
        );
        return EXIT.USAGE;
      }
      const action = actionRaw as ContextSubcommand;
      const runId =
        typeof values.run === "string" ? values.run : undefined;
      if (!runId) {
        process.stderr.write("error: --run <id> is required for context\n");
        return EXIT.USAGE;
      }
      const ctxOpts: Parameters<typeof runContext>[0] = {
        action,
        run: runId,
      };
      if (typeof values.repo === "string") ctxOpts.repo = values.repo;
      if (action === "get" || action === "delete") {
        if (typeof positionals[2] === "string") ctxOpts.key = positionals[2];
      } else if (action === "set") {
        if (typeof positionals[2] === "string") ctxOpts.key = positionals[2];
        if (positionals.length >= 4) {
          ctxOpts.value = positionals.slice(3).join(" ");
        }
      }
      const result = await runContext(ctxOpts);
      return result.exitCode;
    }
    default: {
      process.stderr.write(`error: unknown command '${command}'\n\n${HELP}`);
      return EXIT.USAGE;
    }
  }
}

const isDirectRun =
  typeof process.argv[1] === "string" &&
  (process.argv[1].endsWith("index.js") ||
    process.argv[1].endsWith("index.ts") ||
    process.argv[1].includes("@lazyorch/cli") ||
    process.argv[1].includes("lazyorch"));

if (isDirectRun) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.stack ?? err.message : String(err);
      process.stderr.write(`${msg}\n`);
      process.exitCode = 1;
    });
}

export { main };
