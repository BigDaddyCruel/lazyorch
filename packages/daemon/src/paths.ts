import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

/** Default loopback bind host. */
export const DEFAULT_HOST = "127.0.0.1" as const;

/** Preferred daemon listen port; busy → try up through PORT_RANGE_END. */
export const DEFAULT_PORT = 7420 as const;

/** Inclusive upper bound when scanning for a free port. */
export const PORT_RANGE_END = 7430 as const;

/** HTTP/WS API major version for client negotiation. */
export const API_MAJOR = 1 as const;

/** Safe run_id / event file id: alphanumerics, underscore, hyphen. */
const SAFE_EVENT_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Resolve the user-level LazyOrch state directory.
 * Override via `homeDir` (tests) or `LAZYORCH_HOME` env.
 *
 * Default: `%USERPROFILE%\.lazyorch` (Windows) / `~/.lazyorch`.
 */
export function userLazyorchDir(homeDir?: string): string {
  const base =
    homeDir ??
    process.env.LAZYORCH_HOME ??
    resolveUserHome();
  // If LAZYORCH_HOME / homeDir already points at `.lazyorch`, use as-is.
  if (
    base.endsWith(".lazyorch") ||
    base.endsWith(".lazyorch/") ||
    base.endsWith(".lazyorch\\")
  ) {
    return base;
  }
  return join(base, ".lazyorch");
}

function resolveUserHome(): string {
  if (process.platform === "win32") {
    const profile = process.env.USERPROFILE;
    if (profile && profile.trim() !== "") return profile;
    const drive = process.env.HOMEDRIVE;
    const path = process.env.HOMEPATH;
    if (drive && path) return `${drive}${path}`;
  }
  return homedir();
}

export function daemonLockPath(homeDir?: string): string {
  return join(userLazyorchDir(homeDir), "daemon.lock");
}

export function daemonTokenPath(homeDir?: string): string {
  return join(userLazyorchDir(homeDir), "daemon.token");
}

export function daemonLogPath(homeDir?: string): string {
  return join(userLazyorchDir(homeDir), "daemon.log");
}

export function projectsRegistryPath(homeDir?: string): string {
  return join(userLazyorchDir(homeDir), "projects.json");
}

/** Project-local events directory: `<repo>/.lazyorch/events`. */
export function projectEventsDir(repoRoot: string): string {
  return join(repoRoot, ".lazyorch", "events");
}

/**
 * Sanitize a run_id for use as an events filename segment.
 * Rejects path separators, `.`/`..`, and empty ids.
 */
export function sanitizeEventFileId(runId: string | undefined): string {
  if (runId === undefined || runId.trim() === "") return "_global";
  const id = runId.trim();
  if (id === "." || id === ".." || !SAFE_EVENT_ID.test(id)) {
    throw new Error(
      `Invalid run_id for events path: must match ${SAFE_EVENT_ID} (got ${JSON.stringify(runId)})`,
    );
  }
  return id;
}

/**
 * Event JSONL path for a run (or `_global` when runId omitted).
 * Asserts the resolved path stays under the project events dir.
 */
export function eventJsonlPath(repoRoot: string, runId?: string): string {
  const id = sanitizeEventFileId(runId);
  const eventsDir = resolve(projectEventsDir(repoRoot));
  const path = resolve(eventsDir, `${id}.jsonl`);
  const prefix = eventsDir.endsWith(sep) ? eventsDir : eventsDir + sep;
  if (path !== eventsDir && !path.startsWith(prefix)) {
    throw new Error(`Event path escapes events directory: ${path}`);
  }
  // Also reject if path equals eventsDir without filename (shouldn't happen)
  if (!path.endsWith(".jsonl")) {
    throw new Error(`Event path invalid: ${path}`);
  }
  return path;
}
