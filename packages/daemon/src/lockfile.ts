import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  API_MAJOR,
  DEFAULT_HOST,
  daemonLockPath,
  daemonTokenPath,
  userLazyorchDir,
} from "./paths.js";

const execFileAsync = promisify(execFile);

export interface DaemonLock {
  pid: number;
  host: string;
  port: number;
  started_at: string;
  token_path: string;
  api_major: number;
}

export interface ReadLockResult {
  lock: DaemonLock | null;
  /** True when lock file exists and pid appears alive. */
  healthy: boolean;
  reason?: string;
}

export class ApiMajorMismatchError extends Error {
  readonly code = "api_major_mismatch" as const;
  readonly lockMajor: number;
  readonly expectedMajor: number;

  constructor(lockMajor: number, expectedMajor: number = API_MAJOR) {
    super(
      `Daemon API major mismatch: lock has ${lockMajor}, this process expects ${expectedMajor}. Upgrade CLI/daemon to match.`,
    );
    this.name = "ApiMajorMismatchError";
    this.lockMajor = lockMajor;
    this.expectedMajor = expectedMajor;
  }
}

/**
 * Best-effort pid liveness check (signal 0).
 * Returns false for invalid/dead pids; true when process exists.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? (err as { code: unknown }).code
        : undefined;
    // EPERM: process exists but we cannot signal it
    if (code === "EPERM") return true;
    return false;
  }
}

export async function readDaemonLock(homeDir?: string): Promise<DaemonLock | null> {
  const path = daemonLockPath(homeDir);
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<DaemonLock>;
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.port !== "number" ||
      typeof parsed.host !== "string" ||
      typeof parsed.started_at !== "string" ||
      typeof parsed.token_path !== "string"
    ) {
      return null;
    }
    return {
      pid: parsed.pid,
      host: parsed.host,
      port: parsed.port,
      started_at: parsed.started_at,
      token_path: parsed.token_path,
      api_major: typeof parsed.api_major === "number" ? parsed.api_major : API_MAJOR,
    };
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/**
 * Read lock and check whether the daemon appears healthy (pid alive).
 * Does not perform an HTTP health probe.
 */
export async function inspectDaemonLock(homeDir?: string): Promise<ReadLockResult> {
  const lock = await readDaemonLock(homeDir);
  if (!lock) {
    return { lock: null, healthy: false, reason: "no_lock" };
  }
  if (!isPidAlive(lock.pid)) {
    return { lock, healthy: false, reason: "stale_pid" };
  }
  return { lock, healthy: true };
}

/**
 * Atomically write daemon.lock after ensuring the user state dir exists.
 * Overwrites an existing lock (caller must already own the exclusive claim).
 */
export async function writeDaemonLock(
  lock: DaemonLock,
  homeDir?: string,
): Promise<string> {
  const dir = userLazyorchDir(homeDir);
  await mkdir(dir, { recursive: true });
  const path = daemonLockPath(homeDir);
  const body = `${JSON.stringify(lock, null, 2)}\n`;
  const tmp = join(dirname(path), `.${randomBytes(8).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, body, "utf8");
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
  return path;
}

/**
 * Exclusively create `daemon.lock` (O_EXCL / flag `wx`).
 * Returns true if this process created the file; false if it already existed.
 */
export async function tryCreateDaemonLockExclusive(
  lock: DaemonLock,
  homeDir?: string,
): Promise<boolean> {
  const dir = userLazyorchDir(homeDir);
  await mkdir(dir, { recursive: true });
  const path = daemonLockPath(homeDir);
  const body = `${JSON.stringify(lock, null, 2)}\n`;
  try {
    await writeFile(path, body, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (err) {
    if (isExist(err)) return false;
    throw err;
  }
}

/**
 * Acquire exclusive ownership of the daemon lock before binding.
 * Clears stale locks (dead pid). Throws if a healthy lock is held by another pid
 * unless `force` is true.
 *
 * Returns the provisional lock written to disk (port may be updated after bind).
 */
export async function acquireDaemonLockExclusive(
  provisional: DaemonLock,
  homeDir?: string,
  options: { force?: boolean; maxAttempts?: number } = {},
): Promise<DaemonLock> {
  const maxAttempts = options.maxAttempts ?? 5;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const created = await tryCreateDaemonLockExclusive(provisional, homeDir);
    if (created) return provisional;

    const inspected = await inspectDaemonLock(homeDir);
    if (!inspected.lock || !inspected.healthy) {
      await removeDaemonLock(homeDir, { force: true });
      continue;
    }
    // Live foreign lock
    if (options.force) {
      await removeDaemonLock(homeDir, { force: true });
      continue;
    }
    // Caller should attach instead
    const err = new Error(
      `Daemon lock held by pid ${inspected.lock.pid} on ${inspected.lock.host}:${inspected.lock.port}`,
    );
    (err as Error & { code: string; lock: DaemonLock }).code = "lock_held";
    (err as Error & { code: string; lock: DaemonLock }).lock = inspected.lock;
    throw err;
  }
  throw new Error("Failed to acquire daemon.lock after retries");
}

/**
 * Create a random bearer token file (mode 0600; Windows user-only ACL best-effort).
 */
export async function writeDaemonToken(
  homeDir?: string,
  token?: string,
): Promise<{ path: string; token: string }> {
  const dir = userLazyorchDir(homeDir);
  await mkdir(dir, { recursive: true });
  const path = daemonTokenPath(homeDir);
  const value = token ?? randomBytes(24).toString("hex");
  const body = `${value}\n`;
  const tmp = join(dirname(path), `.${randomBytes(8).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
    try {
      await chmod(tmp, 0o600);
    } catch {
      // Windows may ignore mode; ACL step below
    }
    await rename(tmp, path);
    try {
      await chmod(path, 0o600);
    } catch {
      /* ignore */
    }
    if (process.platform === "win32") {
      await applyWindowsUserOnlyAcl(path);
    }
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
  return { path, token: value };
}

/**
 * Restrict a file to the current user on Windows (icacls: remove inheritance, grant RW).
 * Best-effort — failures are swallowed so startup still works in restricted envs.
 */
export async function applyWindowsUserOnlyAcl(filePath: string): Promise<void> {
  const user = process.env.USERNAME ?? process.env.USER;
  if (!user) return;
  try {
    await execFileAsync("icacls", [filePath, "/inheritance:r"], {
      windowsHide: true,
    });
    await execFileAsync(
      "icacls",
      [filePath, "/grant:r", `${user}:(R,W)`],
      { windowsHide: true },
    );
  } catch {
    // best-effort
  }
}

export async function readDaemonToken(homeDir?: string): Promise<string | null> {
  const path = daemonTokenPath(homeDir);
  try {
    const raw = await readFile(path, "utf8");
    const token = raw.trim();
    return token.length > 0 ? token : null;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** Remove lock file if it belongs to this process (or force). */
export async function removeDaemonLock(
  homeDir?: string,
  options: { force?: boolean; expectedPid?: number } = {},
): Promise<boolean> {
  const path = daemonLockPath(homeDir);
  try {
    if (!options.force) {
      const lock = await readDaemonLock(homeDir);
      if (lock) {
        const expected = options.expectedPid ?? process.pid;
        if (lock.pid !== expected) return false;
      }
    }
    await unlink(path);
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

export async function lockFileExists(homeDir?: string): Promise<boolean> {
  try {
    await access(daemonLockPath(homeDir));
    return true;
  } catch {
    return false;
  }
}

/** Build a lock record for the current process. */
export function buildLock(opts: {
  port: number;
  host?: string;
  tokenPath: string;
  startedAt?: string;
  pid?: number;
  apiMajor?: number;
}): DaemonLock {
  return {
    pid: opts.pid ?? process.pid,
    host: opts.host ?? DEFAULT_HOST,
    port: opts.port,
    started_at: opts.startedAt ?? new Date().toISOString(),
    token_path: opts.tokenPath,
    api_major: opts.apiMajor ?? API_MAJOR,
  };
}

/** Assert lock API major matches this process; throw ApiMajorMismatchError otherwise. */
export function assertApiMajor(lock: DaemonLock, expected: number = API_MAJOR): void {
  if (lock.api_major !== expected) {
    throw new ApiMajorMismatchError(lock.api_major, expected);
  }
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}

function isExist(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "EEXIST"
  );
}
