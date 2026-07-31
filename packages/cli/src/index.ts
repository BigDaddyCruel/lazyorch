#!/usr/bin/env node
/**
 * @lazyorch/cli — lazyorch command-line interface.
 */
import { parseArgs } from "node:util";
import { runInit } from "./commands/init.js";
import { runDoctor } from "./commands/doctor.js";
import { runContext, type ContextSubcommand } from "./commands/context.js";
import { runAdapter, type AdapterSubcommand } from "./commands/adapter.js";

export const PACKAGE_NAME = "@lazyorch/cli" as const;

export function cliPlaceholder(): string {
  return PACKAGE_NAME;
}

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

const HELP = `lazyorch — AI agent orchestration CLI

Usage:
  lazyorch <command> [options]

Commands:
  init     Create .lazyorch/config.yml and project.json skeleton
  doctor   Validate config, slot packing, and adapter binaries
  adapter  Adapter registry (list|register|test)
  context  Shared run context KV (list|get|set|delete)
  help     Show this help

init options:
  --name <n>     Project display name (default: directory name)
  --repo <path>  Repository root (default: cwd)
  --force        Overwrite existing config.yml / project.json

doctor options:
  --repo <path>  Repository root (default: cwd)
  --ci           Treat as CI/headless (timeout_action default fail when unset)
  --no-ci        Force interactive semantics (overrides CI/GITHUB_ACTIONS env)

adapter usage:
  lazyorch adapter list [--repo <path>] [--enabled] [--skip-probe]
  lazyorch adapter register --id <id> --binary <path> [--name <display>] [--start-template <t>] [--capabilities <json>] [--repo <path>]
  lazyorch adapter test [id] [--repo <path>]

context usage:
  lazyorch context list --run <id> [--repo <path>]
  lazyorch context get <key> --run <id> [--repo <path>]
  lazyorch context set <key> <value> --run <id> [--repo <path>]
  lazyorch context delete <key> --run <id> [--repo <path>]
`;

const CONTEXT_ACTIONS = new Set<string>(["list", "get", "set", "delete"]);
const ADAPTER_ACTIONS = new Set<string>(["list", "register", "test"]);

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
        capabilities: { type: "string" },
        enabled: { type: "boolean", default: false },
        "skip-probe": { type: "boolean", default: false },
        force: { type: "boolean", default: false },
        ci: { type: "boolean", default: false },
        "no-ci": { type: "boolean", default: false },
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
    return 2;
  }

  if (values.help === true || positionals[0] === "help") {
    process.stdout.write(HELP);
    return 0;
  }

  if (values.version === true) {
    process.stdout.write("lazyorch 0.0.0\n");
    return 0;
  }

  const command = positionals[0];
  if (!command) {
    process.stdout.write(HELP);
    return 0;
  }

  switch (command) {
    case "init": {
      const initOpts: Parameters<typeof runInit>[0] = {
        force: values.force === true,
      };
      if (typeof values.name === "string") initOpts.name = values.name;
      if (typeof values.repo === "string") initOpts.repo = values.repo;
      await runInit(initOpts);
      return 0;
    }
    case "doctor": {
      const doctorOpts: Parameters<typeof runDoctor>[0] = {};
      if (typeof values.repo === "string") doctorOpts.repo = values.repo;
      // --no-ci wins over --ci and env auto-detect
      if (values["no-ci"] === true) {
        doctorOpts.ci = false;
      } else if (values.ci === true) {
        doctorOpts.ci = true;
      }
      const result = await runDoctor(doctorOpts);
      return result.exitCode;
    }
    case "adapter": {
      const actionRaw = positionals[1];
      if (!actionRaw || !ADAPTER_ACTIONS.has(actionRaw)) {
        process.stderr.write(
          `error: adapter requires list|register|test\n\n${HELP}`,
        );
        return 2;
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
      if (typeof values.capabilities === "string") {
        adapterOpts.capabilitiesJson = values.capabilities;
      }
      if (values.enabled === true) adapterOpts.enabledOnly = true;
      if (values["skip-probe"] === true) adapterOpts.skipProbe = true;
      // Positional id for `adapter test <id>`
      if (action === "test" && typeof positionals[2] === "string") {
        adapterOpts.id = positionals[2];
      }
      // Positional id for `adapter register <id>` when --id omitted
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
        return 2;
      }
      const action = actionRaw as ContextSubcommand;
      const runId =
        typeof values.run === "string" ? values.run : undefined;
      if (!runId) {
        process.stderr.write("error: --run <id> is required for context\n");
        return 2;
      }
      const ctxOpts: Parameters<typeof runContext>[0] = {
        action,
        run: runId,
      };
      if (typeof values.repo === "string") ctxOpts.repo = values.repo;
      // positionals: context <action> [key] [value...]
      if (action === "get" || action === "delete") {
        if (typeof positionals[2] === "string") ctxOpts.key = positionals[2];
      } else if (action === "set") {
        if (typeof positionals[2] === "string") ctxOpts.key = positionals[2];
        if (positionals.length >= 4) {
          // Join remaining args so unquoted multi-word values work.
          ctxOpts.value = positionals.slice(3).join(" ");
        }
      }
      const result = await runContext(ctxOpts);
      return result.exitCode;
    }
    default: {
      process.stderr.write(`error: unknown command '${command}'\n\n${HELP}`);
      return 2;
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
