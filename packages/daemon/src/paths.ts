import { homedir } from "node:os";
import { join } from "node:path";

/** Default loopback bind host. */
export const DEFAULT_HOST = "127.0.0.1" as const;

/** Preferred daemon listen port; busy → try up through PORT_RANGE_END. */
export const DEFAULT_PORT = 7420 as const;

/** Inclusive upper bound when scanning for a free port. */
export const PORT_RANGE_END = 7430 as const;

/** HTTP/WS API major version for client negotiation. */
export const API_MAJOR = 1 as const;

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
  if (base.endsWith(".lazyorch") || base.endsWith(".lazyorch/") || base.endsWith(".lazyorch\\")) {
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

/** Event JSONL path for a run (or `_global` when runId omitted). */
export function eventJsonlPath(repoRoot: string, runId?: string): string {
  const id = runId && runId.length > 0 ? runId : "_global";
  return join(projectEventsDir(repoRoot), `${id}.jsonl`);
}
