/**
 * Path-scope lock manager (KD-15).
 *
 * Prevents concurrent tasks from writing overlapping paths.
 * Lock keys are derived from task `scope[]` globs; acquisition is in
 * sorted key order (global total order → deadlock-free).
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
 * Normalize a scope glob: backslashes → `/`, strip leading `./`,
 * lower-case Windows drive letters.
 */
export function normalizeScope(scope: string): string {
  let s = scope.replace(/\\/g, "/").trim();
  if (s.startsWith("./")) s = s.slice(2);
  // Lower-case drive letter: C:/foo → c:/foo
  if (/^[A-Za-z]:\//.test(s)) {
    s = s.charAt(0).toLowerCase() + s.slice(1);
  }
  // Collapse duplicate slashes (except after drive?)
  s = s.replace(/\/+/g, "/");
  return s;
}

/**
 * Convert a scope glob to a lock key (conservative lattice).
 *
 * - `src/**` or `src/**\/*` → prefix `src/`
 * - `packages/core/src/index.ts` → exact
 * - `**` / `*` → root prefix (locks everything)
 * - Globs with star/question/brackets → prefix before the first glob segment
 *   (e.g. packages/<star>/src/** → prefix packages/)
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
      // Glob at top segment: e.g. *.ts
      return { kind: "prefix", path: "" };
    }
    const base = before.slice(0, slash);
    return { kind: "prefix", path: base.endsWith("/") ? base : `${base}/` };
  }

  // Exact file or directory path (no globs)
  // Trailing slash or stripped dir-glob → prefix
  if (n.endsWith("/") || strippedDirGlob) {
    const path = n.endsWith("/") ? n : `${n}/`;
    return { kind: "prefix", path };
  }
  return { kind: "exact", path: n };
}

function findFirstGlobMeta(s: string): number {
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c === "*" || c === "?" || c === "[") return i;
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
