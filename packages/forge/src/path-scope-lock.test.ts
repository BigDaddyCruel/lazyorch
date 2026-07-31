import { describe, expect, it, beforeEach } from "vitest";
import {
  PathScopeLockManager,
  lockKeyId,
  lockKeysConflict,
  normalizeScope,
  pathUnderPrefix,
  scopeToLockKey,
  scopesConflict,
  scopesToSortedKeyIds,
  type LockKey,
} from "./path-scope-lock.js";

describe("normalizeScope", () => {
  it("converts backslashes to forward slashes", () => {
    expect(normalizeScope("src\\foo\\bar")).toBe("src/foo/bar");
  });

  it("strips leading ./", () => {
    expect(normalizeScope("./src/**")).toBe("src/**");
  });

  it("lower-cases Windows drive letters", () => {
    expect(normalizeScope("C:\\Users\\x\\repo\\src")).toBe("c:/Users/x/repo/src");
  });
});

describe("scopeToLockKey", () => {
  it("maps src/** to prefix src/", () => {
    expect(scopeToLockKey("src/**")).toEqual({ kind: "prefix", path: "src/" });
  });

  it("maps src/**/* to prefix src/", () => {
    expect(scopeToLockKey("src/**/*")).toEqual({ kind: "prefix", path: "src/" });
  });

  it("maps exact file paths", () => {
    expect(scopeToLockKey("packages/core/src/index.ts")).toEqual({
      kind: "exact",
      path: "packages/core/src/index.ts",
    });
  });

  it("maps trailing slash to prefix", () => {
    expect(scopeToLockKey("docs/")).toEqual({ kind: "prefix", path: "docs/" });
  });

  it("maps ** / * to root prefix", () => {
    expect(scopeToLockKey("**")).toEqual({ kind: "prefix", path: "" });
    expect(scopeToLockKey("*")).toEqual({ kind: "prefix", path: "" });
  });

  it("conservatively prefixes globs like src/**/*.ts", () => {
    expect(scopeToLockKey("src/**/*.ts")).toEqual({
      kind: "prefix",
      path: "src/",
    });
  });

  it("handles packages/*/src/** as packages/ prefix", () => {
    expect(scopeToLockKey("packages/*/src/**")).toEqual({
      kind: "prefix",
      path: "packages/",
    });
  });
});

describe("lockKeysConflict / scopesConflict", () => {
  const p = (path: string): LockKey => ({ kind: "prefix", path });
  const e = (path: string): LockKey => ({ kind: "exact", path });

  it("exact vs same exact conflicts", () => {
    expect(lockKeysConflict(e("a.ts"), e("a.ts"))).toBe(true);
    expect(lockKeysConflict(e("a.ts"), e("b.ts"))).toBe(false);
  });

  it("nested prefixes conflict", () => {
    expect(lockKeysConflict(p("src/"), p("src/a/"))).toBe(true);
    expect(lockKeysConflict(p("src/a/"), p("src/"))).toBe(true);
  });

  it("sibling prefixes do not conflict", () => {
    expect(lockKeysConflict(p("src/a/"), p("src/b/"))).toBe(false);
    expect(scopesConflict("src/a/**", "src/b/**")).toBe(false);
  });

  it("exact under prefix conflicts", () => {
    expect(lockKeysConflict(e("src/foo.ts"), p("src/"))).toBe(true);
    expect(scopesConflict("src/foo.ts", "src/**")).toBe(true);
  });

  it("exact outside prefix does not conflict", () => {
    expect(lockKeysConflict(e("lib/foo.ts"), p("src/"))).toBe(false);
  });

  it("root prefix conflicts with everything", () => {
    expect(lockKeysConflict(p(""), e("any/file.ts"))).toBe(true);
    expect(lockKeysConflict(p(""), p("src/"))).toBe(true);
    expect(pathUnderPrefix("x", "")).toBe(true);
  });

  it("overlapping scopes conflict; disjoint do not", () => {
    expect(scopesConflict("packages/core/**", "packages/core/src/index.ts")).toBe(
      true,
    );
    expect(scopesConflict("packages/core/**", "packages/forge/**")).toBe(false);
  });
});

describe("scopesToSortedKeyIds", () => {
  it("returns sorted unique key ids (deadlock order)", () => {
    const ids = scopesToSortedKeyIds(["z/**", "a/file.ts", "m/**"]);
    expect(ids).toEqual([...ids].sort());
    expect(ids.length).toBe(3);
  });

  it("dedupes equivalent scopes", () => {
    const ids = scopesToSortedKeyIds(["src/**", "src/**/*"]);
    expect(ids).toEqual([lockKeyId({ kind: "prefix", path: "src/" })]);
  });
});

describe("PathScopeLockManager", () => {
  let mgr: PathScopeLockManager;

  beforeEach(() => {
    mgr = new PathScopeLockManager();
  });

  it("acquires non-overlapping scopes for two holders", () => {
    const a = mgr.tryAcquire("tsk_a", ["src/a/**"]);
    const b = mgr.tryAcquire("tsk_b", ["src/b/**"]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(mgr.isHolder("tsk_a")).toBe(true);
    expect(mgr.isHolder("tsk_b")).toBe(true);
  });

  it("rejects overlapping scopes", () => {
    expect(mgr.tryAcquire("tsk_a", ["src/**"]).ok).toBe(true);
    const r = mgr.tryAcquire("tsk_b", ["src/foo.ts"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.conflicts.length).toBeGreaterThan(0);
      expect(r.conflicts[0]?.holderId).toBe("tsk_a");
    }
  });

  it("rejects nested prefix overlap", () => {
    expect(mgr.tryAcquire("tsk_a", ["packages/**"]).ok).toBe(true);
    const r = mgr.tryAcquire("tsk_b", ["packages/core/**"]);
    expect(r.ok).toBe(false);
  });

  it("allows re-acquire for same holder (idempotent)", () => {
    expect(mgr.tryAcquire("tsk_a", ["src/**"]).ok).toBe(true);
    const again = mgr.tryAcquire("tsk_a", ["src/**", "src/x.ts"]);
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.keys.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("releases locks so another holder can acquire", () => {
    expect(mgr.tryAcquire("tsk_a", ["src/**"]).ok).toBe(true);
    expect(mgr.tryAcquire("tsk_b", ["src/a.ts"]).ok).toBe(false);
    expect(mgr.release("tsk_a")).toBeGreaterThan(0);
    expect(mgr.isHolder("tsk_a")).toBe(false);
    expect(mgr.tryAcquire("tsk_b", ["src/a.ts"]).ok).toBe(true);
  });

  it("acquires multiple scopes in sorted order atomically", () => {
    const r = mgr.tryAcquire("tsk_a", ["z/**", "a/**", "m/file.ts"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.keys).toEqual([...r.keys].sort());
    }
    // Same exact file conflicts; sibling exact under m/ does not
    expect(mgr.tryAcquire("tsk_b", ["m/file.ts"]).ok).toBe(false);
    expect(mgr.tryAcquire("tsk_b2", ["m/other.ts"]).ok).toBe(true);
    // Sibling of a/** ok
    expect(mgr.tryAcquire("tsk_c", ["b/**"]).ok).toBe(true);
    // Overlap on z/** fails even with an extra free scope
    expect(mgr.tryAcquire("tsk_d", ["z/nested/**", "free/**"]).ok).toBe(false);
  });

  it("detectConflicts reports holders without acquiring", () => {
    mgr.tryAcquire("tsk_a", ["docs/**"]);
    const c = mgr.detectConflicts(["docs/readme.md"]);
    expect(c.length).toBeGreaterThan(0);
    expect(c[0]?.holderId).toBe("tsk_a");
    expect(mgr.detectConflicts(["docs/readme.md"], "tsk_a")).toEqual([]);
  });

  it("listHeld returns all locks sorted", () => {
    mgr.tryAcquire("tsk_a", ["a/**"]);
    mgr.tryAcquire("tsk_b", ["z/**"]);
    const held = mgr.listHeld();
    expect(held.length).toBe(2);
    expect(held.map((h) => h.keyId)).toEqual(
      [...held.map((h) => h.keyId)].sort(),
    );
  });

  it("keeps locks after simulated blocked (no auto-release)", () => {
    mgr.tryAcquire("tsk_a", ["src/**"]);
    // blocked_reason: integrate_conflict — locks remain
    expect(mgr.heldBy("tsk_a").length).toBeGreaterThan(0);
    expect(mgr.tryAcquire("tsk_dyn", ["src/x.ts"]).ok).toBe(false);
  });

  it("throws on empty holderId", () => {
    expect(() => mgr.tryAcquire("", ["src/**"])).toThrow(/holderId/);
  });

  it("clear wipes all state", () => {
    mgr.tryAcquire("tsk_a", ["src/**"]);
    mgr.clear();
    expect(mgr.listHeld()).toEqual([]);
    expect(mgr.tryAcquire("tsk_b", ["src/**"]).ok).toBe(true);
  });
});
