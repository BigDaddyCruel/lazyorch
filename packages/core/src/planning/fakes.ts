import type { PlanReviewerPort, PlanWriterPort } from "./ports.js";
import type {
  PlanReviewContext,
  PlanReviewResult,
  PlanWriteContext,
  PlanWriteResult,
} from "./types.js";

/**
 * In-memory plan writer. Script responses via constructor queue or {@link enqueue}.
 * Optional `handler` overrides the queue for dynamic behavior.
 */
export class FakePlanWriter implements PlanWriterPort {
  readonly calls: PlanWriteContext[] = [];
  private readonly queue: PlanWriteResult[];
  private handler?: (
    ctx: PlanWriteContext,
  ) => PlanWriteResult | Promise<PlanWriteResult>;

  constructor(
    results: PlanWriteResult[] = [],
    handler?: (
      ctx: PlanWriteContext,
    ) => PlanWriteResult | Promise<PlanWriteResult>,
  ) {
    this.queue = [...results];
    if (handler !== undefined) {
      this.handler = handler;
    }
  }

  enqueue(result: PlanWriteResult): void {
    this.queue.push(result);
  }

  setHandler(
    handler: (
      ctx: PlanWriteContext,
    ) => PlanWriteResult | Promise<PlanWriteResult>,
  ): void {
    this.handler = handler;
  }

  async write(ctx: PlanWriteContext): Promise<PlanWriteResult> {
    this.calls.push(ctx);
    if (this.handler) {
      return this.handler(ctx);
    }
    const next = this.queue.shift();
    if (!next) {
      throw new Error(
        `FakePlanWriter: no scripted result for revision ${ctx.revision} (call #${this.calls.length})`,
      );
    }
    return next;
  }
}

/**
 * In-memory plan reviewer. Script responses via constructor queue or {@link enqueue}.
 */
export class FakePlanReviewer implements PlanReviewerPort {
  readonly calls: PlanReviewContext[] = [];
  private readonly queue: PlanReviewResult[];
  private handler?: (
    ctx: PlanReviewContext,
  ) => PlanReviewResult | Promise<PlanReviewResult>;

  constructor(
    results: PlanReviewResult[] = [],
    handler?: (
      ctx: PlanReviewContext,
    ) => PlanReviewResult | Promise<PlanReviewResult>,
  ) {
    this.queue = [...results];
    if (handler !== undefined) {
      this.handler = handler;
    }
  }

  enqueue(result: PlanReviewResult): void {
    this.queue.push(result);
  }

  setHandler(
    handler: (
      ctx: PlanReviewContext,
    ) => PlanReviewResult | Promise<PlanReviewResult>,
  ): void {
    this.handler = handler;
  }

  async review(ctx: PlanReviewContext): Promise<PlanReviewResult> {
    this.calls.push(ctx);
    if (this.handler) {
      return this.handler(ctx);
    }
    const next = this.queue.shift();
    if (!next) {
      throw new Error(
        `FakePlanReviewer: no scripted result for revision ${ctx.revision} (call #${this.calls.length})`,
      );
    }
    return next;
  }
}
