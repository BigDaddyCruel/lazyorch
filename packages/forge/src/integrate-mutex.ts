/**
 * Global feature-branch integration mutex (KD-33 / KD-34).
 *
 * Per run (feature branch), at most one integrate operation at a time.
 * Integrate is a daemon/forge git job — no agent slot.
 *
 * On conflict: release mutex immediately; task → blocked/integrate_conflict;
 * path-scope locks stay on the task (handled by orchestrator, not this mutex).
 */

export type MutexAcquireResult =
  | { ok: true }
  | { ok: false; holder: string };

/**
 * In-process integration mutex keyed by run id.
 * Production daemon uses one instance per process; tests inject fakes/new instances.
 */
export class IntegrationMutex {
  /** runId → taskId currently holding the mutex */
  private readonly holders = new Map<string, string>();

  /**
   * Try to acquire the integrate mutex for `runId` on behalf of `taskId`.
   * Re-acquire by the same task is idempotent success.
   */
  tryAcquire(runId: string, taskId: string): MutexAcquireResult {
    if (runId === "") throw new Error("runId must be non-empty");
    if (taskId === "") throw new Error("taskId must be non-empty");

    const current = this.holders.get(runId);
    if (current !== undefined && current !== taskId) {
      return { ok: false, holder: current };
    }
    this.holders.set(runId, taskId);
    return { ok: true };
  }

  /** Release mutex for run. No-op if not held. Returns true if released. */
  release(runId: string): boolean {
    return this.holders.delete(runId);
  }

  /** Release only if held by `taskId`. */
  releaseIfHolder(runId: string, taskId: string): boolean {
    if (this.holders.get(runId) !== taskId) return false;
    return this.holders.delete(runId);
  }

  /** Task id holding the mutex for this run, if any. */
  holder(runId: string): string | undefined {
    return this.holders.get(runId);
  }

  isHeld(runId: string): boolean {
    return this.holders.has(runId);
  }

  clear(): void {
    this.holders.clear();
  }
}
