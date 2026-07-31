import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  API_MAJOR,
  DEFAULT_HOST,
  DEFAULT_PORT,
} from "./paths.js";
import {
  ApiMajorMismatchError,
  assertApiMajor,
  inspectDaemonLock,
  readDaemonToken,
} from "./lockfile.js";
import { startDaemon, type ServeOptions, type ServeResult } from "./serve.js";

export interface DaemonEndpoint {
  url: string;
  host: string;
  port: number;
  token: string;
  pid?: number;
  /** True when this call started a new daemon. */
  started: boolean;
  /** In-process serve result when started inline (not background spawn). */
  serve?: ServeResult;
}

export interface EnsureDaemonOptions {
  homeDir?: string;
  /** Prefer LAZYORCH_URL when set (default true). */
  useEnvUrl?: boolean;
  /**
   * How to start a missing daemon:
   * - `inline` (default): start in-process via startDaemon (tests / embedded)
   * - `spawn`: spawn `lazyorchd serve --background` child
   * - `none`: never start; throw if not running
   */
  mode?: "inline" | "spawn" | "none";
  host?: string;
  port?: number;
  /** Custom spawn implementation (tests). */
  spawnDaemon?: () => Promise<DaemonEndpoint>;
  /** Max wait after spawn for health (ms). */
  spawnTimeoutMs?: number;
}

/**
 * Discover or start the user-level daemon.
 *
 * Discovery order:
 * 1. `LAZYORCH_URL` env (if useEnvUrl)
 * 2. Healthy `daemon.lock` + HTTP /health (API major must match)
 * 3. Auto-start per `mode`
 */
export async function ensureDaemon(
  options: EnsureDaemonOptions = {},
): Promise<DaemonEndpoint> {
  const homeDir = options.homeDir;
  const useEnvUrl = options.useEnvUrl !== false;
  const mode = options.mode ?? "inline";

  if (useEnvUrl) {
    const envUrl = process.env.LAZYORCH_URL?.trim();
    if (envUrl) {
      const parsed = parseDaemonUrl(envUrl);
      const ok = await probe(parsed.url);
      if (ok) {
        const token = (await readDaemonToken(homeDir)) ?? "";
        return {
          url: parsed.url,
          host: parsed.host,
          port: parsed.port,
          token,
          started: false,
        };
      }
    }
  }

  const inspected = await inspectDaemonLock(homeDir);
  if (inspected.healthy && inspected.lock) {
    assertApiMajor(inspected.lock);
    const url = `http://${inspected.lock.host}:${inspected.lock.port}`;
    const ok = await probe(url);
    if (ok) {
      const token = (await readDaemonToken(homeDir)) ?? "";
      const ep: DaemonEndpoint = {
        url,
        host: inspected.lock.host,
        port: inspected.lock.port,
        token,
        started: false,
      };
      ep.pid = inspected.lock.pid;
      return ep;
    }
  }

  if (mode === "none") {
    throw new Error(
      "LazyOrch daemon is not running (lock missing or unhealthy); start with `lazyorchd serve`",
    );
  }

  if (mode === "spawn") {
    if (options.spawnDaemon) {
      return options.spawnDaemon();
    }
    return spawnBackgroundDaemon(options);
  }

  // inline
  const serveOpts: ServeOptions = {
    host: options.host ?? DEFAULT_HOST,
    port: options.port ?? DEFAULT_PORT,
    attachIfRunning: true,
  };
  if (homeDir !== undefined) serveOpts.homeDir = homeDir;
  const serve = await startDaemon(serveOpts);
  const ep: DaemonEndpoint = {
    url: serve.url,
    host: serve.host,
    port: serve.port,
    token: serve.token,
    started: serve.started,
    serve,
  };
  ep.pid = serve.lock.pid;
  return ep;
}

function parseDaemonUrl(url: string): {
  url: string;
  host: string;
  port: number;
} {
  const u = new URL(url);
  const port =
    u.port !== ""
      ? Number(u.port)
      : u.protocol === "https:"
        ? 443
        : 80;
  return {
    url: u.origin,
    host: u.hostname,
    port,
  };
}

async function probe(url: string): Promise<boolean> {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1000);
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}/health`, {
        signal: ac.signal,
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { ok?: boolean; api_major?: number };
      if (body.ok !== true) return false;
      if (typeof body.api_major === "number" && body.api_major !== API_MAJOR) {
        return false;
      }
      return true;
    } finally {
      clearTimeout(t);
    }
  } catch {
    return false;
  }
}

async function spawnBackgroundDaemon(
  options: EnsureDaemonOptions,
): Promise<DaemonEndpoint> {
  const timeoutMs = options.spawnTimeoutMs ?? 10_000;
  const entry = resolveDaemonEntry();
  const args = ["serve", "--background"];
  if (options.port !== undefined) {
    args.push("--port", String(options.port));
  }
  if (options.homeDir) {
    args.push("--home", options.homeDir);
  }

  const child: ChildProcess = spawn(process.execPath, [entry, ...args], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      ...(options.homeDir
        ? { LAZYORCH_HOME: options.homeDir }
        : {}),
    },
  });
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(100);
    const inspected = await inspectDaemonLock(options.homeDir);
    if (inspected.healthy && inspected.lock) {
      try {
        assertApiMajor(inspected.lock);
      } catch (err) {
        if (err instanceof ApiMajorMismatchError) throw err;
        throw err;
      }
      const url = `http://${inspected.lock.host}:${inspected.lock.port}`;
      if (await probe(url)) {
        const token = (await readDaemonToken(options.homeDir)) ?? "";
        const ep: DaemonEndpoint = {
          url,
          host: inspected.lock.host,
          port: inspected.lock.port,
          token,
          started: true,
        };
        ep.pid = inspected.lock.pid;
        return ep;
      }
    }
  }

  throw new Error(
    `Timed out waiting for background daemon after ${timeoutMs}ms`,
  );
}

function resolveDaemonEntry(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, "index.js");
  } catch {
    return "lazyorchd";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
