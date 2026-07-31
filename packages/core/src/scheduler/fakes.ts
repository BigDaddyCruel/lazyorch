/**
 * Test fakes for scheduler ports (no real git / LLM).
 */

import type { Task } from "../types/task.js";
import type {
  ScopeLockAcquireResult,
  ScopeLockPort,
  WorktreePaths,
  WorktreePort,
} from "./types.js";

/**
 * Minimal in-memory path-scope lock (prefix/exact not modeled — exact string
 * set intersection). Sufficient for scheduler unit tests; production uses
 * forge PathScopeLockManager.
 */
export class FakeScopeLockManager implements ScopeLockPort {
  /** holderId → scopes held */
  private readonly held = new Map<string, string[]>();

  tryAcquire(
    holderId: string,
    scopes: readonly string[],
  ): ScopeLockAcquireResult {
    if (holderId === "") {
      throw new Error("holderId must be non-empty");
    }
    if (scopes.length === 0) {
      return { ok: true, keys: [] };
    }

    const conflicts: Array<{ holderId: string }> = [];
    for (const [other, otherScopes] of this.held) {
      if (other === holderId) continue;
      for (const s of scopes) {
        if (otherScopes.includes(s) || scopesOverlap(s, otherScopes)) {
          conflicts.push({ holderId: other });
          break;
        }
      }
    }
    if (conflicts.length > 0) {
      return { ok: false, conflicts };
    }

    const prev = this.held.get(holderId) ?? [];
    const merged = [...new Set([...prev, ...scopes])];
    this.held.set(holderId, merged);
    return { ok: true, keys: [...scopes] };
  }

  release(holderId: string): number {
    const set = this.held.get(holderId);
    if (!set) return 0;
    const n = set.length;
    this.held.delete(holderId);
    return n;
  }

  heldBy(holderId: string): string[] {
    return [...(this.held.get(holderId) ?? [])];
  }

  isHolder(holderId: string): boolean {
    return this.held.has(holderId);
  }

  clear(): void {
    this.held.clear();
  }
}

/** Conservative: equal scopes or either is `**`. */
function scopesOverlap(scope: string, held: readonly string[]): boolean {
  for (const h of held) {
    if (h === scope) return true;
    if (h === "**" || scope === "**") return true;
    // Simple prefix: "src/**" covers "src/a.ts" style in tests when both use same prefix token
    if (h.endsWith("/**") && scope.startsWith(h.slice(0, -3))) return true;
    if (scope.endsWith("/**") && h.startsWith(scope.slice(0, -3))) return true;
  }
  return false;
}

/** Sync worktree fake: deterministic paths, no git. */
export class FakeWorktreePort implements WorktreePort {
  readonly created: WorktreePaths[] = [];
  failForTaskIds = new Set<string>();
  cleanPaths = new Set<string>();

  ensureWorktree(task: Task): WorktreePaths {
    if (this.failForTaskIds.has(task.id)) {
      throw new Error(`fake worktree failed for ${task.id}`);
    }
    const paths: WorktreePaths = {
      worktreePath: `/tmp/wt/${task.run_id}/${task.id}`,
      branch: `lazyorch/${task.run_id}/${task.id}`,
    };
    this.created.push(paths);
    this.cleanPaths.add(paths.worktreePath);
    return paths;
  }

  isClean(worktreePath: string): boolean {
    return this.cleanPaths.has(worktreePath);
  }
}
