/**
 * Fake PlanningSessionPort for E2E freeze without live LLMs.
 */

import type {
  PlanningSessionOutcome,
  PlanningSessionPort,
  PlanningSessionRequest,
} from "./ports.js";
import type {
  PlanReviewResult,
  PlanWriteResult,
} from "./types.js";

export type FakeSessionHandler = (
  req: PlanningSessionRequest,
) => PlanningSessionOutcome | Promise<PlanningSessionOutcome>;

/**
 * Scriptable planning session fake.
 * Queue or handler returns write/review payloads; records every request
 * (including routed adapter/model/tier) for assertions.
 */
export class FakePlanningSession implements PlanningSessionPort {
  readonly requests: PlanningSessionRequest[] = [];
  private readonly writeQueue: PlanWriteResult[];
  private readonly reviewQueue: PlanReviewResult[];
  private handler?: FakeSessionHandler;

  constructor(options?: {
    writes?: PlanWriteResult[];
    reviews?: PlanReviewResult[];
    handler?: FakeSessionHandler;
  }) {
    this.writeQueue = [...(options?.writes ?? [])];
    this.reviewQueue = [...(options?.reviews ?? [])];
    if (options?.handler !== undefined) {
      this.handler = options.handler;
    }
  }

  enqueueWrite(result: PlanWriteResult): void {
    this.writeQueue.push(result);
  }

  enqueueReview(result: PlanReviewResult): void {
    this.reviewQueue.push(result);
  }

  setHandler(handler: FakeSessionHandler): void {
    this.handler = handler;
  }

  async run(req: PlanningSessionRequest): Promise<PlanningSessionOutcome> {
    this.requests.push(req);

    if (this.handler) {
      return this.handler(req);
    }

    if (req.role === "plan_writer") {
      const write = this.writeQueue.shift();
      if (!write) {
        return {
          status: "error",
          error_message: `FakePlanningSession: no scripted write for revision ${req.write_ctx?.revision ?? "?"} (call #${this.requests.length})`,
          adapter_id: req.adapter_id,
          model_used: req.model,
        };
      }
      return {
        status: "ok",
        write,
        adapter_id: req.adapter_id,
        model_used: req.model,
        summary: `fake plan_writer via ${req.adapter_id}/${req.model}`,
      };
    }

    const review = this.reviewQueue.shift();
    if (!review) {
      return {
        status: "error",
        error_message: `FakePlanningSession: no scripted review for revision ${req.review_ctx?.revision ?? "?"} (call #${this.requests.length})`,
        adapter_id: req.adapter_id,
        model_used: req.model,
      };
    }
    return {
      status: "ok",
      review,
      adapter_id: req.adapter_id,
      model_used: req.model,
      summary: `fake plan_reviewer via ${req.adapter_id}/${req.model}`,
    };
  }

  /** Requests for a given role. */
  byRole(role: PlanningSessionRequest["role"]): PlanningSessionRequest[] {
    return this.requests.filter((r) => r.role === role);
  }

  clear(): void {
    this.requests.length = 0;
    this.writeQueue.length = 0;
    this.reviewQueue.length = 0;
  }
}
