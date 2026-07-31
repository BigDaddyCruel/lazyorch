/**
 * Test fakes for Implementing phase ports (no real git / LLM).
 */

import type {
  ForgeIntegratePort,
  ForgeIntegrateRequest,
  ForgeIntegrateResult,
  IntegrationMutexAcquireResult,
  IntegrationMutexPort,
  ReviewerSessionOutcome,
  ReviewerSessionPort,
  ReviewerSessionRequest,
  WorkerSessionOutcome,
  WorkerSessionPort,
  WorkerSessionRequest,
} from "./ports.js";

/** In-memory integration mutex (same semantics as forge IntegrationMutex). */
export class FakeIntegrationMutex implements IntegrationMutexPort {
  private readonly holders = new Map<string, string>();

  tryAcquire(runId: string, taskId: string): IntegrationMutexAcquireResult {
    const current = this.holders.get(runId);
    if (current !== undefined && current !== taskId) {
      return { ok: false, holder: current };
    }
    this.holders.set(runId, taskId);
    return { ok: true };
  }

  release(runId: string): boolean {
    return this.holders.delete(runId);
  }

  releaseIfHolder(runId: string, taskId: string): boolean {
    if (this.holders.get(runId) !== taskId) return false;
    return this.holders.delete(runId);
  }

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

/** Scripted forge integrate (queue of results per call). */
export class FakeForgeIntegrate implements ForgeIntegratePort {
  readonly calls: ForgeIntegrateRequest[] = [];
  private readonly queue: ForgeIntegrateResult[];
  tipCounter = 0;

  constructor(results?: ForgeIntegrateResult[]) {
    this.queue = [...(results ?? [])];
  }

  enqueue(...results: ForgeIntegrateResult[]): void {
    this.queue.push(...results);
  }

  async integrate(req: ForgeIntegrateRequest): Promise<ForgeIntegrateResult> {
    this.calls.push(req);
    const next = this.queue.shift();
    if (next) return next;
    this.tipCounter += 1;
    return {
      status: "ok",
      feature_tip_sha: `tip_${String(this.tipCounter).padStart(8, "0")}`,
    };
  }
}

/** Scripted worker outcomes keyed by task id (or FIFO default). */
export class FakeWorkerSession implements WorkerSessionPort {
  readonly requests: WorkerSessionRequest[] = [];
  private readonly byTask = new Map<string, WorkerSessionOutcome[]>();
  private readonly fifo: WorkerSessionOutcome[] = [];

  constructor(options?: {
    byTask?: Record<string, WorkerSessionOutcome[]>;
    defaultQueue?: WorkerSessionOutcome[];
  }) {
    if (options?.byTask) {
      for (const [id, q] of Object.entries(options.byTask)) {
        this.byTask.set(id, [...q]);
      }
    }
    if (options?.defaultQueue) {
      this.fifo.push(...options.defaultQueue);
    }
  }

  enqueue(taskId: string, ...outcomes: WorkerSessionOutcome[]): void {
    const q = this.byTask.get(taskId) ?? [];
    q.push(...outcomes);
    this.byTask.set(taskId, q);
  }

  enqueueDefault(...outcomes: WorkerSessionOutcome[]): void {
    this.fifo.push(...outcomes);
  }

  async run(req: WorkerSessionRequest): Promise<WorkerSessionOutcome> {
    this.requests.push(req);
    const q = this.byTask.get(req.task.id);
    if (q && q.length > 0) {
      return q.shift()!;
    }
    if (this.fifo.length > 0) {
      return this.fifo.shift()!;
    }
    return { kind: "submit_for_review", summary: "fake default submit" };
  }
}

/** Scripted reviewer decisions. */
export class FakeReviewerSession implements ReviewerSessionPort {
  readonly requests: ReviewerSessionRequest[] = [];
  private readonly byTask = new Map<string, ReviewerSessionOutcome[]>();
  private readonly fifo: ReviewerSessionOutcome[] = [];

  constructor(options?: {
    byTask?: Record<string, ReviewerSessionOutcome[]>;
    defaultQueue?: ReviewerSessionOutcome[];
  }) {
    if (options?.byTask) {
      for (const [id, q] of Object.entries(options.byTask)) {
        this.byTask.set(id, [...q]);
      }
    }
    if (options?.defaultQueue) {
      this.fifo.push(...options.defaultQueue);
    }
  }

  enqueue(taskId: string, ...outcomes: ReviewerSessionOutcome[]): void {
    const q = this.byTask.get(taskId) ?? [];
    q.push(...outcomes);
    this.byTask.set(taskId, q);
  }

  enqueueDefault(...outcomes: ReviewerSessionOutcome[]): void {
    this.fifo.push(...outcomes);
  }

  async run(req: ReviewerSessionRequest): Promise<ReviewerSessionOutcome> {
    this.requests.push(req);
    const q = this.byTask.get(req.task.id);
    if (q && q.length > 0) {
      return q.shift()!;
    }
    if (this.fifo.length > 0) {
      return this.fifo.shift()!;
    }
    return { decision: "approve", summary: "fake approve" };
  }
}
