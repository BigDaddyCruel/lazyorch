/**
 * Session-backed plan writer / reviewer handlers.
 * Use model router for large-tier floors + injectable PlanningSessionPort.
 */

import type { RouteResult } from "../models/types.js";
import { skillsForRoleDefault } from "../team/role-templates.js";
import type { Agent } from "../types/agent.js";
import type {
  PlanReviewerPort,
  PlanWriterPort,
  PlanningRoutingOptions,
  PlanningSessionPort,
  PlanningSessionRequest,
} from "./ports.js";
import { routePlanningSession } from "./route.js";
import type {
  PlanReviewContext,
  PlanReviewResult,
  PlanWriteContext,
  PlanWriteResult,
} from "./types.js";

const DEFAULT_WRITER_PROMPT = [
  "You are the plan writer for LazyOrch.",
  "Produce DESIGN.md, TASK_DAG.json, and PR_PLAN.md for the given idea.",
  "Every task needs non-empty title, description, acceptance[], scope[], role_affinity[].",
  "Respond with structured plan_write result (artifacts + optional issue_updates).",
].join("\n");

const DEFAULT_REVIEWER_PROMPT = [
  "You are the plan reviewer for LazyOrch.",
  "Adversarially review DESIGN + TASK_DAG + PR_PLAN against the checklist.",
  "Return structured PlanIssue[] (open issues block freeze).",
  "Respond with structured plan_review result (issues array).",
].join("\n");

export interface SessionHandlerBase {
  session: PlanningSessionPort;
  agent: Agent;
  /** Project root / cwd for sessions. */
  cwd: string;
  routing?: PlanningRoutingOptions;
  role_prompt?: string;
  skills?: readonly string[];
  env?: Record<string, string>;
  max_turns?: number;
  timeout_ms?: number;
  approval_policy?: "auto" | "suggest" | "manual";
  /** Optional fixed route (skips re-route per call). */
  fixed_route?: RouteResult;
  /** Collect last route for tests / observability. */
  onRouted?: (route: RouteResult) => void;
}

export type SessionPlanWriterOptions = SessionHandlerBase;

/**
 * PlanWriterPort backed by PlanningSessionPort + model router.
 * Routes plan_writer (floor large) before each write session.
 */
export class SessionPlanWriter implements PlanWriterPort {
  readonly routes: RouteResult[] = [];
  private readonly opts: SessionPlanWriterOptions;

  constructor(opts: SessionPlanWriterOptions) {
    this.opts = opts;
  }

  /** Last routed session (undefined before first write). */
  get lastRoute(): RouteResult | undefined {
    return this.routes[this.routes.length - 1];
  }

  async write(ctx: PlanWriteContext): Promise<PlanWriteResult> {
    const route = this.resolveRoute();
    this.routes.push(route);
    this.opts.onRouted?.(route);

    if (route.error) {
      throw new Error(
        `SessionPlanWriter: routing failed: ${route.error} (adapter=${route.adapter_id})`,
      );
    }

    const req = this.buildRequest(route, { write_ctx: ctx });
    const outcome = await this.opts.session.run(req);

    if (outcome.status !== "ok") {
      throw new Error(
        outcome.error_message ??
          `SessionPlanWriter: session ${outcome.status}`,
      );
    }
    if (!outcome.write) {
      throw new Error("SessionPlanWriter: session ok but missing write payload");
    }
    return outcome.write;
  }

  private resolveRoute(): RouteResult {
    if (this.opts.fixed_route) return this.opts.fixed_route;
    return routePlanningSession({
      role: "plan_writer",
      agent: this.opts.agent,
      ...(this.opts.routing !== undefined ? { routing: this.opts.routing } : {}),
    });
  }

  private buildRequest(
    route: RouteResult,
    ctx: { write_ctx: PlanWriteContext },
  ): PlanningSessionRequest {
    const skills =
      this.opts.skills ?? skillsForRoleDefault("plan_writer");
    const req: PlanningSessionRequest = {
      role: "plan_writer",
      agent_id: this.opts.agent.id,
      adapter_id: route.adapter_id,
      model: route.model,
      model_tier: route.tier,
      session_kind: route.session_kind,
      skills: [...skills],
      role_prompt: this.opts.role_prompt ?? DEFAULT_WRITER_PROMPT,
      write_ctx: ctx.write_ctx,
      cwd: this.opts.cwd,
    };
    if (route.effort !== undefined) req.effort = route.effort;
    if (route.score !== undefined) req.complexity_score = route.score;
    if (this.opts.env !== undefined) req.env = this.opts.env;
    if (this.opts.max_turns !== undefined) req.max_turns = this.opts.max_turns;
    if (this.opts.timeout_ms !== undefined) req.timeout_ms = this.opts.timeout_ms;
    if (this.opts.approval_policy !== undefined) {
      req.approval_policy = this.opts.approval_policy;
    }
    return req;
  }
}

export type SessionPlanReviewerOptions = SessionHandlerBase;

/**
 * PlanReviewerPort backed by PlanningSessionPort + model router.
 * Routes plan_reviewer (floor large) before each review session.
 */
export class SessionPlanReviewer implements PlanReviewerPort {
  readonly routes: RouteResult[] = [];
  private readonly opts: SessionPlanReviewerOptions;

  constructor(opts: SessionPlanReviewerOptions) {
    this.opts = opts;
  }

  get lastRoute(): RouteResult | undefined {
    return this.routes[this.routes.length - 1];
  }

  async review(ctx: PlanReviewContext): Promise<PlanReviewResult> {
    const route = this.resolveRoute();
    this.routes.push(route);
    this.opts.onRouted?.(route);

    if (route.error) {
      throw new Error(
        `SessionPlanReviewer: routing failed: ${route.error} (adapter=${route.adapter_id})`,
      );
    }

    const req = this.buildRequest(route, { review_ctx: ctx });
    const outcome = await this.opts.session.run(req);

    if (outcome.status !== "ok") {
      throw new Error(
        outcome.error_message ??
          `SessionPlanReviewer: session ${outcome.status}`,
      );
    }
    if (!outcome.review) {
      throw new Error(
        "SessionPlanReviewer: session ok but missing review payload",
      );
    }
    return outcome.review;
  }

  private resolveRoute(): RouteResult {
    if (this.opts.fixed_route) return this.opts.fixed_route;
    return routePlanningSession({
      role: "plan_reviewer",
      agent: this.opts.agent,
      ...(this.opts.routing !== undefined ? { routing: this.opts.routing } : {}),
    });
  }

  private buildRequest(
    route: RouteResult,
    ctx: { review_ctx: PlanReviewContext },
  ): PlanningSessionRequest {
    const skills =
      this.opts.skills ?? skillsForRoleDefault("plan_reviewer");
    const req: PlanningSessionRequest = {
      role: "plan_reviewer",
      agent_id: this.opts.agent.id,
      adapter_id: route.adapter_id,
      model: route.model,
      model_tier: route.tier,
      session_kind: route.session_kind,
      skills: [...skills],
      role_prompt: this.opts.role_prompt ?? DEFAULT_REVIEWER_PROMPT,
      review_ctx: ctx.review_ctx,
      cwd: this.opts.cwd,
    };
    if (route.effort !== undefined) req.effort = route.effort;
    if (route.score !== undefined) req.complexity_score = route.score;
    if (this.opts.env !== undefined) req.env = this.opts.env;
    if (this.opts.max_turns !== undefined) req.max_turns = this.opts.max_turns;
    if (this.opts.timeout_ms !== undefined) req.timeout_ms = this.opts.timeout_ms;
    if (this.opts.approval_policy !== undefined) {
      req.approval_policy = this.opts.approval_policy;
    }
    return req;
  }
}
