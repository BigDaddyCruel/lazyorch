/**
 * PATH binary discovery (Windows PATHEXT / where semantics; POSIX PATH).
 * Injectable fs access + env for unit tests (no real PATH required).
 */

import { access, constants } from "node:fs/promises";
import path from "node:path";

export interface DiscoverEnv {
  PATH?: string;
  Path?: string;
  PATHEXT?: string;
}

export interface DiscoverOptions {
  /** Override platform (default process.platform). */
  platform?: NodeJS.Platform;
  /** Env for PATH / PATHEXT (default process.env). */
  env?: DiscoverEnv;
  /**
   * Injected existence check. Defaults to fs.access F_OK.
   * Must return true only if the path is usable as an executable candidate.
   */
  exists?: (path: string) => Promise<boolean>;
}

async function defaultExists(pathName: string): Promise<boolean> {
  try {
    await access(pathName, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function pathEntries(env: DiscoverEnv, platform: NodeJS.Platform): string[] {
  const raw = env.PATH ?? env.Path ?? "";
  const sep = platform === "win32" ? ";" : ":";
  return raw.split(sep).filter((d) => d.length > 0);
}

function winExts(env: DiscoverEnv): string[] {
  const raw = env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM";
  return raw
    .split(";")
    .map((e) => e.trim())
    .filter(Boolean);
}

/** Join dir + name using the *logical* platform (tests may force linux on win hosts). */
function joinPath(
  platform: NodeJS.Platform,
  dir: string,
  name: string,
): string {
  const impl = platform === "win32" ? path.win32 : path.posix;
  return impl.join(dir, name);
}

function looksLikePath(name: string): boolean {
  return (
    path.win32.isAbsolute(name) ||
    path.posix.isAbsolute(name) ||
    name.includes("/") ||
    name.includes("\\") ||
    /^[A-Za-z]:/.test(name)
  );
}

/**
 * Resolve a single binary name or path to an absolute path when found.
 * Returns null if not found.
 */
export async function resolveBinary(
  name: string,
  options: DiscoverOptions = {},
): Promise<string | null> {
  if (!name || name === "shell") return null;

  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? defaultExists;

  // Absolute / relative path — check filesystem directly.
  if (looksLikePath(name)) {
    // Windows: PATHEXT first (where/CreateProcess order), then bare path.
    // Avoids binding npm's extensionless shim when claude.cmd exists.
    if (platform === "win32" && !/\.[A-Za-z0-9]+$/.test(name)) {
      for (const ext of winExts(env)) {
        const candidate = name + ext;
        if (await exists(candidate)) return candidate;
      }
    }
    if (await exists(name)) return name;
    return null;
  }

  const dirs = pathEntries(env, platform);

  for (const dir of dirs) {
    if (platform === "win32") {
      const base = joinPath(platform, dir, name);
      // PATHEXT first (matches where.exe / CreateProcess), then extensionless.
      for (const ext of winExts(env)) {
        const p = base + ext;
        if (await exists(p)) return p;
      }
      if (await exists(base)) return base;
    } else {
      const p = joinPath(platform, dir, name);
      if (await exists(p)) return p;
    }
  }
  return null;
}

export interface DiscoverResult {
  /** Candidate that matched (as provided). */
  candidate: string;
  /** Absolute or verified path. */
  binary_path: string;
}

/**
 * Try candidates in order; return first resolvable on PATH / filesystem.
 */
export async function discoverBinary(
  candidates: readonly string[],
  options: DiscoverOptions = {},
): Promise<DiscoverResult | null> {
  for (const c of candidates) {
    if (!c) continue;
    const resolved = await resolveBinary(c, options);
    if (resolved) {
      return { candidate: c, binary_path: resolved };
    }
  }
  return null;
}
