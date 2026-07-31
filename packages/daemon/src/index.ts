#!/usr/bin/env node
/**
 * @lazyorch/daemon — user-level HTTP/SSE server, lockfile lifecycle, multi-project registry.
 */
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { startDaemon, stopDaemon } from "./serve.js";
import { daemonLogPath, userLazyorchDir } from "./paths.js";
import { inspectDaemonLock, readDaemonToken } from "./lockfile.js";

export const PACKAGE_NAME = "@lazyorch/daemon" as const;

export function daemonPlaceholder(): string {
  return PACKAGE_NAME;
}

// --- paths ---
export {
  API_MAJOR,
  DEFAULT_HOST,
  DEFAULT_PORT,
  PORT_RANGE_END,
  userLazyorchDir,
  daemonLockPath,
  daemonTokenPath,
  daemonLogPath,
  projectsRegistryPath,
  projectEventsDir,
  eventJsonlPath,
  sanitizeEventFileId,
} from "./paths.js";

// --- lockfile ---
export {
  isPidAlive,
  readDaemonLock,
  inspectDaemonLock,
  writeDaemonLock,
  writeDaemonToken,
  readDaemonToken,
  removeDaemonLock,
  lockFileExists,
  buildLock,
  acquireDaemonLockExclusive,
  tryCreateDaemonLockExclusive,
  assertApiMajor,
  ApiMajorMismatchError,
  type DaemonLock,
  type ReadLockResult,
} from "./lockfile.js";

// --- project registry ---
export {
  ProjectRegistry,
  normalizeRepoRoot,
  RegistryConflictError,
  type RegisteredProject,
  type ProjectRegistryFile,
} from "./project-registry.js";

// --- events ---
export {
  appendEventJsonl,
  readEventJsonl,
  ensureEventsDir,
  createEvent,
  EventBus,
  type EventEnvelope,
  type EventType,
  type AppendEventOptions,
} from "./events.js";

// --- HTTP ---
export {
  createDaemonHttpServer,
  tokensEqual,
  readBody,
  MAX_BODY_BYTES,
  type DaemonHttpContext,
  type DaemonHttpServer,
  type StubRun,
} from "./http-server.js";

// --- serve ---
export {
  startDaemon,
  stopDaemon,
  isPortFree,
  pickPort,
  appendDaemonLog,
  type ServeOptions,
  type ServeResult,
} from "./serve.js";

// --- ensureDaemon (CLI/GUI helper) ---
export {
  ensureDaemon,
  type DaemonEndpoint,
  type EnsureDaemonOptions,
} from "./ensure-daemon.js";

// ---------------------------------------------------------------------------
// CLI entry: lazyorchd / node dist/index.js serve
// ---------------------------------------------------------------------------

const HELP = `lazyorchd — LazyOrch user-level daemon

Usage:
  lazyorchd serve [options]
  lazyorchd help

Options:
  --port <n>       Preferred port (default 7420; scans 7420-7430)
  --host <addr>    Bind address (default 127.0.0.1)
  --home <dir>     Override user state root (or LAZYORCH_HOME)
  --background     Re-spawn detached (stdio → daemon.log) and exit parent
  --require-auth   Require Bearer token even on loopback
  -h, --help       Show help
`;

async function main(argv: string[]): Promise<number> {
  let values: Record<string, unknown>;
  let positionals: string[];

  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        port: { type: "string" },
        host: { type: "string" },
        home: { type: "string" },
        background: { type: "boolean", default: false },
        "require-auth": { type: "boolean", default: false },
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

  if (values.help === true || positionals[0] === "help" || !positionals[0]) {
    process.stdout.write(HELP);
    return 0;
  }

  if (values.version === true) {
    process.stdout.write("lazyorchd 0.0.0\n");
    return 0;
  }

  const command = positionals[0];
  if (command !== "serve") {
    process.stderr.write(`error: unknown command '${command}'\n\n${HELP}`);
    return 2;
  }

  const port =
    typeof values.port === "string" ? Number(values.port) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 0)) {
    process.stderr.write("error: --port must be a non-negative integer\n");
    return 2;
  }

  const homeDir =
    typeof values.home === "string"
      ? values.home
      : process.env.LAZYORCH_HOME;

  // --background: parent re-spawns detached child, waits for health, exits
  if (
    values.background === true &&
    process.env.LAZYORCH_DAEMON_CHILD !== "1"
  ) {
    return spawnBackgroundParent(argv, homeDir);
  }

  const serveOpts: Parameters<typeof startDaemon>[0] = {
    requireAuth: values["require-auth"] === true,
    attachIfRunning: true,
  };
  if (homeDir !== undefined) serveOpts.homeDir = homeDir;
  if (typeof values.host === "string") serveOpts.host = values.host;
  if (port !== undefined) serveOpts.port = port;

  const result = await startDaemon(serveOpts);

  if (!result.started) {
    process.stdout.write(
      `daemon already running at ${result.url} (pid ${result.lock.pid})\n`,
    );
    return 0;
  }

  process.stdout.write(
    `lazyorchd listening on ${result.url} (pid ${process.pid})\n`,
  );
  process.stdout.write(`lock: port=${result.port} token set\n`);

  const shutdown = async (signal: string): Promise<void> => {
    process.stderr.write(`\nshutting down (${signal})...\n`);
    try {
      await stopDaemon(result, homeDir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`shutdown error: ${msg}\n`);
    }
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  // Keep process alive
  await new Promise<void>(() => {
    /* never resolves; signals handle exit */
  });
  return 0;
}

/**
 * Parent process for `serve --background`: detach a child with logs, wait for
 * /health, print URL, exit 0.
 */
async function spawnBackgroundParent(
  argv: string[],
  homeDir: string | undefined,
): Promise<number> {
  const entry = process.argv[1];
  if (!entry) {
    process.stderr.write("error: cannot resolve daemon entry for --background\n");
    return 1;
  }

  // Strip --background from child argv; mark child via env
  const childArgs = argv.filter((a) => a !== "--background");
  // Ensure `serve` is present
  if (!childArgs.includes("serve")) {
    childArgs.unshift("serve");
  }

  const stateDir = userLazyorchDir(homeDir);
  mkdirSync(stateDir, { recursive: true });
  const logPath = daemonLogPath(homeDir);
  let logFd: number;
  try {
    logFd = openSync(logPath, "a");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: cannot open daemon.log: ${msg}\n`);
    return 1;
  }

  const child = spawn(process.execPath, [entry, ...childArgs], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      LAZYORCH_DAEMON_CHILD: "1",
      ...(homeDir ? { LAZYORCH_HOME: homeDir } : {}),
    },
  });
  child.unref();

  const timeoutMs = 10_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    const inspected = await inspectDaemonLock(homeDir);
    if (inspected.healthy && inspected.lock && inspected.lock.port > 0) {
      const url = `http://${inspected.lock.host}:${inspected.lock.port}`;
      try {
        const res = await fetch(`${url}/health`);
        if (res.ok) {
          const token = (await readDaemonToken(homeDir)) ?? "";
          process.stdout.write(
            `daemon started in background at ${url} (pid ${inspected.lock.pid})\n`,
          );
          if (token) {
            process.stdout.write(`token file: ${inspected.lock.token_path}\n`);
          }
          process.stdout.write(`log: ${logPath}\n`);
          return 0;
        }
      } catch {
        /* retry */
      }
    }
  }

  process.stderr.write(
    `error: timed out waiting for background daemon (${timeoutMs}ms); see ${logPath}\n`,
  );
  return 1;
}

const isDirectRun =
  typeof process.argv[1] === "string" &&
  (process.argv[1].endsWith("index.js") ||
    process.argv[1].endsWith("index.ts") ||
    process.argv[1].includes("@lazyorch/daemon") ||
    process.argv[1].includes("lazyorchd"));

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
