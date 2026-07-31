/**
 * Path-scope lock manager (KD-15).
 *
 * Prevents concurrent tasks from writing overlapping paths.
 * Lock keys are derived from task `scope[]` globs; acquisition is in
 * sorted key order (global total order → deadlock-free).
 *
 * Acquisition is atomic (all keys or none): no partial hold-and-wait, so
 * classic ABBA deadlock cannot occur. Sorted order matches KD-15 and keeps
 * future wait/retry designs safe.
 */

/** Kind of lock key after normalizing a scope glob. */
export type LockKeyKind = "prefix" | "exact";

/**
 * Canonical lock key.
 * - `prefix` + path `src/`  covers everything under that prefix
 * - `exact`  + path `foo.ts` covers only that path
 * - root prefix uses empty path `""` (from `**` / `*`)
 */
export interface LockKey {
  kind: LockKeyKind;
  /** Forward-slash path; prefix keys end with `/` unless root (`""`). */
  path: string;
}

/** Stable string form used for sorting and map keys. */
export function lockKeyId(key: LockKey): string {
  return key.kind === "prefix" ? `p:${key.path}` : `e:${key.path}`;
}

export function compareLockKeyIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Normalize a scope glob: backslashes → `/`, collapse `/./` and duplicate
 * slashes, strip leading `./` (repeated) and a leading `/` (scopes are
 * repo-relative), lower-case Windows drive letters.
 */
export function normalizeScope(scope: string): string {
  let s = scope.replace(/\\/g, "/").trim();

  // Lower-case drive letter: C:/foo → c:/foo
  if (/^[A-Za-z]:\//.test(s)) {
    s = s.charAt(0).toLowerCase() + s.slice(1);
  }

  // Collapse /./ segments and duplicate slashes
  while (s.includes("/./")) {
    s = s.replace(/\/\.\//g, "/");
  }
  s = s.replace(/\/+/g, "/");

  // Strip leading ./ repeatedly
  while (s.startsWith("./")) {
    s = s.slice(2);
  }
  if (s.endsWith("/.")) {
    s = s.slice(0, -2);
  }
  if (s === ".") {
    s = "";
  }

  // Repo-relative: strip leading slash(es) so `/src/**` ≡ `src/**`.
  // Keep Windows drive paths (c:/...) intact.
  if (s.startsWith("/") && !/^[A-Za-z]:\//.test(s)) {
    s = s.replace(/^\/+/, "");
  }

  return s;
}

/**
 * Convert a scope glob to a lock key (conservative lattice).
 *
 * - `src/**` → prefix `src/`
 * - `packages/core/src/index.ts` → exact (known file suffix)
 * - bare dirs (`packages/core`, `docs`) → prefix (no file suffix)
 * - `**` / `*` → root prefix (locks everything)
 * - Globs with star/question/brackets/braces → prefix before first glob segment
 */
export function scopeToLockKey(scope: string): LockKey {
  let n = normalizeScope(scope);
  if (n === "" || n === "**" || n === "*" || n === "/**" || n === "/**/*") {
    return { kind: "prefix", path: "" };
  }

  // Strip trailing /** or /* directory wildcards → work on the base, then
  // scan for remaining globs (e.g. packages/<star>/src/** → packages/<star>/src).
  let strippedDirGlob = false;
  const starStar = n.match(/^(.*?)\/\*\*(?:\/.*)?$/);
  if (starStar) {
    n = starStar[1] ?? "";
    strippedDirGlob = true;
    if (n === "" || n === ".") return { kind: "prefix", path: "" };
  } else {
    const singleStarDir = n.match(/^(.*?)\/\*$/);
    if (singleStarDir) {
      n = singleStarDir[1] ?? "";
      strippedDirGlob = true;
      if (n === "" || n === ".") return { kind: "prefix", path: "" };
    }
  }

  // Any remaining glob metacharacter: take longest non-glob prefix directory
  const globIdx = findFirstGlobMeta(n);
  if (globIdx !== -1) {
    const before = n.slice(0, globIdx);
    const slash = before.lastIndexOf("/");
    if (slash <= 0) {
      // Glob at top segment: e.g. *.ts or {a,b}/**
      return { kind: "prefix", path: "" };
    }
    const base = before.slice(0, slash);
    return { kind: "prefix", path: base.endsWith("/") ? base : `${base}/` };
  }

  // Trailing slash or stripped dir-glob → prefix
  if (n.endsWith("/") || strippedDirGlob) {
    const path = n.endsWith("/") ? n : `${n}/`;
    return { kind: "prefix", path };
  }

  // Bare paths: files (suffix) stay exact; directories become prefixes so
  // "packages/core" conflicts with "packages/core/src/index.ts" (KD-15).
  if (!looksLikeFilePath(n)) {
    return { kind: "prefix", path: `${n}/` };
  }
  return { kind: "exact", path: n };
}

/**
 * True if the last path segment looks like a filename with an extension
 * (e.g. index.ts). Bare segments without a suffix are treated as directories.
 */
export function looksLikeFilePath(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  if (base === "" || base === "." || base === "..") return false;
  const dot = base.lastIndexOf(".");
  // ".gitignore" / ".env" — leading-dot names without a further extension
  // are config files; treat as exact files when they have more than the leading dot
  // and a non-empty "extension" after another dot, else as files if only leading dot.
  if (dot <= 0) {
    // ".gitignore" → treat as file (common config); "Makefile" → directory-like prefix
    return base.startsWith(".") && base.length > 1;
  }
  if (dot === base.length - 1) return false;
  const ext = base.slice(dot + 1);
  return /^[A-Za-z0-9]{1,16}$/.test(ext);
}

function findFirstGlobMeta(s: string): number {
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    // Brace groups are globs under KD-15 conservative lattice
    if (c === "*" || c === "?" || c === "[" || c === "{") return i;
  }
  return -1;
}

/** True if `path` is covered by prefix key `prefixPath` ("" = root). */
export function pathUnderPrefix(path: string, prefixPath: string): boolean {
  if (prefixPath === "" || prefixPath === "/") return true;
  const p = prefixPath.endsWith("/") ? prefixPath : `${prefixPath}/`;
  const bare = p.slice(0, -1);
  return path === bare || path.startsWith(p);
}

/**
 * Two lock keys conflict if they may cover a common path (conservative).
 */
export function lockKeysConflict(a: LockKey, b: LockKey): boolean {
  if (a.kind === "exact" && b.kind === "exact") {
    return a.path === b.path;
  }
  if (a.kind === "prefix" && b.kind === "prefix") {
    // One prefix contains the other (including equal)
    return (
      pathUnderPrefix(b.path.replace(/\/$/, "") || "", a.path) ||
      pathUnderPrefix(a.path.replace(/\/$/, "") || "", b.path) ||
      a.path === b.path
    );
  }
  const exact = a.kind === "exact" ? a : b;
  const prefix = a.kind === "prefix" ? a : b;
  return pathUnderPrefix(exact.path, prefix.path);
}

/** Whether two scope globs conflict (via their lock keys). */
export function scopesConflict(a: string, b: string): boolean {
  return lockKeysConflict(scopeToLockKey(a), scopeToLockKey(b));
}

/** Derive sorted unique lock-key ids for a list of scopes. */
export function scopesToSortedKeyIds(scopes: readonly string[]): string[] {
  const keys = scopes.map(scopeToLockKey);
  const ids = [...new Set(keys.map(lockKeyId))];
  ids.sort(compareLockKeyIds);
  return ids;
}

export interface HeldLock {
  holderId: string;
  keyId: string;
  key: LockKey;
}

export interface ScopeConflict {
  holderId: string;
  heldKey: LockKey;
  requestedKey: LockKey;
}

export type AcquireResult =
  | { ok: true; keys: string[] }
  | { ok: false; conflicts: ScopeConflict[] };

/**
 * In-process path-scope lock manager.
 *
 * Acquisition is atomic over the full key set after sorting (deadlock-free).
 * An empty `scopes` list is a no-op success (`ok: true`, `keys: []`) — useful
 * when callers only lock when coding scopes exist.
 * Locks stay until explicit release (including while task is `blocked`).
 */
export class PathScopeLockManager {
  /** keyId → holderId */
  private readonly holders = new Map<string, string>();
  /** keyId → LockKey */
  private readonly keys = new Map<string, LockKey>();
  /** holderId → set of keyIds */
  private readonly byHolder = new Map<string, Set<string>>();

  /**
   * Try to acquire all lock keys for `scopes` on behalf of `holderId`.
   * Keys are computed, sorted, then granted atomically or not at all.
   * Re-acquiring the same scopes for the same holder is idempotent.
   * Empty `scopes` succeeds with no keys held (no-op).
   */
  tryAcquire(holderId: string, scopes: readonly string[]): AcquireResult {
    if (holderId === "") {
      throw new Error("holderId must be non-empty");
    }

    const lockKeys = scopes.map(scopeToLockKey);
    const unique = new Map<string, LockKey>();
    for (const k of lockKeys) {
      unique.set(lockKeyId(k), k);
    }
    const sortedIds = [...unique.keys()].sort(compareLockKeyIds);

    const conflicts: ScopeConflict[] = [];
    for (const id of sortedIds) {
      const requested = unique.get(id)!;
      // Conflict with any held key by another holder
      for (const [heldId, heldKey] of this.keys) {
        const holder = this.holders.get(heldId);
        if (holder === undefined || holder === holderId) continue;
        if (lockKeysConflict(requested, heldKey)) {
          conflicts.push({
            holderId: holder,
            heldKey,
            requestedKey: requested,
          });
        }
      }
    }

    if (conflicts.length > 0) {
      return { ok: false, conflicts };
    }

    // Empty scope list: no-op success (do not register a holder entry)
    if (sortedIds.length === 0) {
      return { ok: true, keys: [] };
    }

    // Grant all keys (idempotent for same holder)
    let set = this.byHolder.get(holderId);
    if (!set) {
      set = new Set();
      this.byHolder.set(holderId, set);
    }
    for (const id of sortedIds) {
      this.holders.set(id, holderId);
      this.keys.set(id, unique.get(id)!);
      set.add(id);
    }

    return { ok: true, keys: sortedIds };
  }

  /**
   * Release all locks held by `holderId`.
   * @returns number of keys released
   */
  release(holderId: string): number {
    const set = this.byHolder.get(holderId);
    if (!set) return 0;
    let n = 0;
    for (const id of set) {
      if (this.holders.get(id) === holderId) {
        this.holders.delete(id);
        this.keys.delete(id);
        n++;
      }
    }
    this.byHolder.delete(holderId);
    return n;
  }

  /** Keys currently held by this holder. */
  heldBy(holderId: string): string[] {
    const set = this.byHolder.get(holderId);
    if (!set) return [];
    return [...set].sort(compareLockKeyIds);
  }

  /** Holder of a specific key id, if any. */
  holderOf(keyId: string): string | undefined {
    return this.holders.get(keyId);
  }

  /** True if holder currently holds any locks. */
  isHolder(holderId: string): boolean {
    const set = this.byHolder.get(holderId);
    return set !== undefined && set.size > 0;
  }

  /**
   * Detect conflicts between `scopes` and currently held locks
   * (excluding optional `excludeHolderId`).
   */
  detectConflicts(
    scopes: readonly string[],
    excludeHolderId?: string,
  ): ScopeConflict[] {
    const conflicts: ScopeConflict[] = [];
    for (const scope of scopes) {
      const requested = scopeToLockKey(scope);
      for (const [heldId, heldKey] of this.keys) {
        const holder = this.holders.get(heldId);
        if (holder === undefined) continue;
        if (excludeHolderId !== undefined && holder === excludeHolderId) {
          continue;
        }
        if (lockKeysConflict(requested, heldKey)) {
          conflicts.push({
            holderId: holder,
            heldKey,
            requestedKey: requested,
          });
        }
      }
    }
    return conflicts;
  }

  /** Snapshot of all held locks. */
  listHeld(): HeldLock[] {
    const out: HeldLock[] = [];
    for (const [keyId, holderId] of this.holders) {
      const key = this.keys.get(keyId);
      if (!key) continue;
      out.push({ holderId, keyId, key });
    }
    out.sort((a, b) => compareLockKeyIds(a.keyId, b.keyId));
    return out;
  }

  /** Clear all locks (tests / daemon reset). */
  clear(): void {
    this.holders.clear();
    this.keys.clear();
    this.byHolder.clear();
  }
}
