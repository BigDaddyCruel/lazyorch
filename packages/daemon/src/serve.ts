import { createServer as createNetServer } from "node:net";
import { appendFile, mkdir } from "node:fs/promises";
import {
  API_MAJOR,
  DEFAULT_HOST,
  DEFAULT_PORT,
  PORT_RANGE_END,
  daemonLogPath,
  daemonTokenPath,
  userLazyorchDir,
} from "./paths.js";
import {
  ApiMajorMismatchError,
  acquireDaemonLockExclusive,
  assertApiMajor,
  buildLock,
  inspectDaemonLock,
  isPidAlive,
  readDaemonLock,
  readDaemonToken,
  removeDaemonLock,
  writeDaemonLock,
  writeDaemonToken,
  type DaemonLock,
} from "./lockfile.js";
import { ProjectRegistry } from "./project-registry.js";
import { EventBus, createEvent } from "./events.js";
import {
  createDaemonHttpServer,
  type DaemonHttpContext,
  type DaemonHttpServer,
} from "./http-server.js";

export interface ServeOptions {
  /** Override user home / LAZYORCH_HOME for state dir. */
  homeDir?: string;
  host?: string;
  /** Preferred port; if busy, scan up to PORT_RANGE_END unless fixedPort. port 0 = OS ephemeral. */
  port?: number;
  /** When true, do not scan — fail if preferred port is taken. */
  fixedPort?: boolean;
  /** If another healthy daemon holds the lock, return it instead of starting. */
  attachIfRunning?: boolean;
  /** Force Bearer auth even on loopback. */
  requireAuth?: boolean;
  /** Pre-set token (tests). Only written when this process becomes the owner. */
  token?: string;
  /** Append a start line to daemon.log (default true). */
  writeLog?: boolean;
  /** Max ms to wait for mid-bind owner HTTP when attaching (default 2500). */
  attachRetryMs?: number;
}

export interface ServeResult {
  /** True when this process owns the server. */
  started: boolean;
  host: string;
  port: number;
  url: string;
  token: string;
  lock: DaemonLock;
  http?: DaemonHttpServer;
  registry?: ProjectRegistry;
  bus?: EventBus;
}

/**
 * Probe whether a TCP port is free on host.
 */
export function isPortFree(port: number, host: string = DEFAULT_HOST): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createNetServer();
    srv.unref();
    srv.once("error", () => {
      resolve(false);
    });
    srv.listen(port, host, () => {
      srv.close(() => resolve(true));
    });
  });
}

/**
 * Pick first free port starting at `preferred`.
 * Default design range is 7420–7430 (span of 10). When `preferred` is outside
 * that window (e.g. tests), scan `preferred .. preferred+10`.
 */
export async function pickPort(
  preferred: number = DEFAULT_PORT,
  host: string = DEFAULT_HOST,
  fixed = false,
): Promise<number> {
  if (fixed) {
    if (await isPortFree(preferred, host)) return preferred;
    throw new Error(`Port ${preferred} on ${host} is not free`);
  }
  const span = PORT_RANGE_END - DEFAULT_PORT;
  const end =
    preferred >= DEFAULT_PORT && preferred <= PORT_RANGE_END
      ? PORT_RANGE_END
      : preferred + span;
  for (let p = preferred; p <= end; p++) {
    if (await isPortFree(p, host)) return p;
  }
  throw new Error(
    `No free port in range ${preferred}-${end} on ${host}`,
  );
}

/**
 * Start the user-level daemon (HTTP + SSE) with exclusive lockfile single-instance.
 *
 * Token is written only after this process owns the exclusive lock (after bind
 * succeeds for the final lock record). Attach paths only read `daemon.token`.
 */
export async function startDaemon(
  options: ServeOptions = {},
): Promise<ServeResult> {
  const homeDir = options.homeDir;
  const host = options.host ?? DEFAULT_HOST;
  const preferred = options.port ?? DEFAULT_PORT;
  const attachIfRunning = options.attachIfRunning !== false;
  const attachRetryMs = options.attachRetryMs ?? 2500;
  // Path only — file is not written until we own the lock
  const tokenPath = daemonTokenPath(homeDir);

  if (attachIfRunning) {
    const attachOpts: Parameters<typeof tryAttachExisting>[1] = { retryMs: 0 };
    if (options.token !== undefined) attachOpts.fallbackToken = options.token;
    const attached = await tryAttachExisting(homeDir, attachOpts);
    if (attached) return attached;
  }

  const startedAt = new Date().toISOString();
  const provisional = buildLock({
    port: preferred === 0 ? 0 : preferred,
    host,
    tokenPath,
    startedAt,
  });

  try {
    await acquireDaemonLockExclusive(provisional, homeDir, {
      force: !attachIfRunning,
    });
  } catch (err) {
    if (isLockHeldError(err) && attachIfRunning) {
      // Owner may still be binding; retry health + re-read lock/token
      const held = err.lock;
      const attachOpts: Parameters<typeof tryAttachExisting>[1] = {
        retryMs: attachRetryMs,
        knownLock: held,
      };
      if (options.token !== undefined) attachOpts.fallbackToken = options.token;
      const attached = await tryAttachExisting(homeDir, attachOpts);
      if (attached) return attached;
    }
    throw err;
  }

  // --- We own the exclusive lock. Token write is safe only from here. ---
  let http: DaemonHttpServer | undefined;
  try {
    const wantEphemeral = preferred === 0;
    const portHint = wantEphemeral
      ? 0
      : await pickPort(preferred, host, options.fixedPort === true);

    // Rotate token only as lock owner (before bind so disk matches memory
    // by the time /health is reachable).
    const { token } = await writeDaemonToken(homeDir, options.token);

    const registry = new ProjectRegistry(homeDir);
    await registry.load();
    const bus = new EventBus();

    const httpCtx: DaemonHttpContext = {
      registry,
      bus,
      token,
      startedAt,
      host,
      port: portHint,
    };
    if (options.requireAuth !== undefined) {
      httpCtx.requireAuth = options.requireAuth;
    }
    http = createDaemonHttpServer(httpCtx);

    await new Promise<void>((resolve, reject) => {
      http!.server.once("error", reject);
      http!.server.listen(portHint, host, () => resolve());
    });

    const addr = http.server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("Failed to bind daemon HTTP server");
    }
    const port = addr.port;
    http.ctx.port = port;

    const lock = buildLock({
      port,
      host,
      tokenPath,
      startedAt,
    });
    await writeDaemonLock(lock, homeDir);

    if (options.writeLog !== false) {
      await appendDaemonLog(
        homeDir,
        `started pid=${process.pid} url=http://${host}:${port} at=${startedAt}\n`,
      );
    }

    bus.publish(
      createEvent({
        project_id: "_daemon",
        type: "daemon.started",
        payload: {
          host,
          port,
          api_major: API_MAJOR,
          pid: process.pid,
        },
      }),
    );

    return {
      started: true,
      host,
      port,
      url: `http://${host}:${port}`,
      token,
      lock,
      http,
      registry,
      bus,
    };
  } catch (err) {
    if (http) {
      try {
        await http.close();
      } catch {
        /* ignore */
      }
    }
    await removeDaemonLock(homeDir, {
      force: true,
      expectedPid: process.pid,
    });
    throw err;
  }
}

/**
 * Stop a daemon started by `startDaemon` and remove the lock if we own it.
 */
export async function stopDaemon(
  result: ServeResult,
  homeDir?: string,
): Promise<void> {
  if (result.http) {
    await result.http.close();
  }
  if (result.started) {
    await removeDaemonLock(homeDir, {
      expectedPid: result.lock.pid,
      force: false,
    });
    await appendDaemonLog(
      homeDir,
      `stopped pid=${result.lock.pid} at=${new Date().toISOString()}\n`,
    ).catch(() => undefined);
  }
}

export async function appendDaemonLog(
  homeDir: string | undefined,
  line: string,
): Promise<void> {
  const dir = userLazyorchDir(homeDir);
  await mkdir(dir, { recursive: true });
  await appendFile(daemonLogPath(homeDir), line, "utf8");
}

/**
 * Attach to an existing healthy daemon. Never writes the token file.
 * When `retryMs` > 0, polls until HTTP is up (mid-bind owner) or deadline.
 */
async function tryAttachExisting(
  homeDir: string | undefined,
  opts: {
    retryMs: number;
    knownLock?: DaemonLock;
    fallbackToken?: string;
  },
): Promise<ServeResult | null> {
  const deadline = Date.now() + Math.max(0, opts.retryMs);
  let attempt = 0;

  for (;;) {
    attempt += 1;
    let lock = opts.knownLock;
    if (!lock || attempt > 1) {
      const inspected = await inspectDaemonLock(homeDir);
      if (!inspected.lock) {
        if (Date.now() >= deadline) return null;
        await sleep(50);
        continue;
      }
      if (!inspected.healthy) {
        // Dead pid only — safe to clear
        if (!isPidAlive(inspected.lock.pid)) {
          await removeDaemonLock(homeDir, { force: true });
        }
        if (Date.now() >= deadline) return null;
        await sleep(50);
        continue;
      }
      lock = inspected.lock;
    } else {
      // Refresh known lock (port may update after owner binds)
      const latest = await readDaemonLock(homeDir);
      if (latest && isPidAlive(latest.pid)) {
        lock = latest;
      } else if (latest && !isPidAlive(latest.pid)) {
        await removeDaemonLock(homeDir, { force: true });
        if (Date.now() >= deadline) return null;
        await sleep(50);
        continue;
      }
    }

    try {
      assertApiMajor(lock);
    } catch {
      throw new ApiMajorMismatchError(lock.api_major);
    }

    if (lock.port > 0 && (await probeHealth(lock.host, lock.port))) {
      // Attach path: read only — never rotate token
      const token = (await readDaemonToken(homeDir)) ?? opts.fallbackToken ?? "";
      return {
        started: false,
        host: lock.host,
        port: lock.port,
        url: `http://${lock.host}:${lock.port}`,
        token,
        lock,
      };
    }

    if (Date.now() >= deadline) {
      // Live pid but HTTP never became ready within window
      return null;
    }
    await sleep(50);
  }
}

function isLockHeldError(
  err: unknown,
): err is Error & { code: "lock_held"; lock: DaemonLock } {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "lock_held" &&
    "lock" in err &&
    typeof (err as { lock: unknown }).lock === "object" &&
    (err as { lock: unknown }).lock !== null
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function probeHealth(host: string, port: number): Promise<boolean> {
  if (port <= 0) return false;
  const url = `http://${host}:${port}/health`;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1000);
    try {
      const res = await fetch(url, { signal: ac.signal });
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

export { ApiMajorMismatchError };
