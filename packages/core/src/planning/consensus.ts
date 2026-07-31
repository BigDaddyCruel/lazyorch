import { generateId } from "@lazyorch/shared";
import {
  countOpenIssues,
  transitionPlanIssue,
} from "../plan-issue.js";
import { transitionRunPhase } from "../orchestrator/run-fsm.js";
import type { PlanIssue } from "../types/plan.js";
import type { Run } from "../types/run.js";
import { buildPlan, computeFreezeHash, materializePlanTasks } from "./materialize.js";
import type { PlanReviewerPort, PlanWriterPort } from "./ports.js";
import type {
  ConsensusConfig,
  ConsensusResult,
  IssueUpdate,
  PlanArtifacts,
} from "./types.js";
import { validateFreeze } from "./validators.js";

export class PlanningError extends Error {
  readonly code: "invalid_phase" | "writer" | "reviewer";

  constructor(code: PlanningError["code"], message: string) {
    super(message);
    this.name = "PlanningError";
    this.code = code;
  }
}

const DEFAULT_CONFIG: ConsensusConfig = {
  max_rounds: 5,
  max_design_bytes: 524_288,
  strict_scopes: true,
};

export interface RunConsensusParams {
  run: Run;
  idea?: string;
  writer: PlanWriterPort;
  reviewer: PlanReviewerPort;
  config?: Partial<ConsensusConfig>;
  /** Seed plan id (stable across revisions). */
  plan_id?: string;
  /** Prior frozen plan when mid-run replan. */
  prior_plan?: import("../types/plan.js").Plan;
  /** ISO clock; defaults to Date.now. */
  now?: () => string;
}

/**
 * Apply writer issue_updates onto the current issue list.
 * Unknown issue ids are ignored; illegal transitions throw PlanIssueError.
 */
export function applyIssueUpdates(
  issues: readonly PlanIssue[],
  updates: readonly IssueUpdate[] | undefined,
  now: string,
): PlanIssue[] {
  if (!updates || updates.length === 0) {
    return [...issues];
  }
  const byId = new Map(issues.map((i) => [i.id, i]));
  for (const u of updates) {
    const cur = byId.get(u.issue_id);
    if (!cur) continue;
    const next = transitionPlanIssue(cur, u.status, {
      response: u.response,
      updated_at: now,
    });
    byId.set(u.issue_id, next);
  }
  return issues.map((i) => byId.get(i.id) ?? i);
}

/**
 * Planning consensus: write → review → revise until 0 open issues + freeze
 * validators pass, or max_rounds exhausted.
 *
 * Side effects on the returned run:
 * - stays in Planning while iterating (self-edge)
 * - on freeze: Planning → PlanConsensus
 * - on max_rounds: remains Planning (caller opens plan_max_rounds gate)
 *
 * No real LLM adapters — uses injected writer/reviewer ports.
 */
export async function runConsensus(
  params: RunConsensusParams,
): Promise<{ result: ConsensusResult; run: Run }> {
  const {
    writer,
    reviewer,
    prior_plan,
  } = params;
  const idea = params.idea ?? params.run.idea;
  const cfg: ConsensusConfig = { ...DEFAULT_CONFIG, ...params.config };
  const now = params.now ?? (() => new Date().toISOString());
  const planId = params.plan_id ?? prior_plan?.id ?? generateId("plan");
  const createdAt = prior_plan?.created_at ?? now();

  let run = params.run;
  if (run.phase !== "Planning" && run.phase !== "PlanConsensus") {
    // Allow entry from Inception by transitioning into Planning
    if (run.phase === "Inception") {
      run = transitionRunPhase(run, "Planning", { updated_at: now() });
    } else {
      throw new PlanningError(
        "invalid_phase",
        `runConsensus requires Planning (or Inception), got ${run.phase}`,
      );
    }
  }
  if (run.phase === "PlanConsensus") {
    // Restart consensus (e.g. plan_approve reject → revise)
    run = transitionRunPhase(run, "Planning", { updated_at: now() });
  }

  let artifacts: PlanArtifacts | undefined;
  let issues: PlanIssue[] = [];
  let revision = 0;
  let rounds = 0;

  // Initial write
  revision = 1;
  const write1 = await writer.write({
    idea,
    run_id: run.id,
    revision,
    open_issues: [],
    ...(prior_plan !== undefined ? { prior_plan } : {}),
  });
  artifacts = write1.artifacts;
  issues = applyIssueUpdates([], write1.issue_updates, now());

  // Review / revise loop
  while (true) {
    rounds += 1;

    // Self-edge models an internal plan round
    run = transitionRunPhase(run, "Planning", { updated_at: now() });

    const review = await reviewer.review({
      idea,
      run_id: run.id,
      revision,
      artifacts,
      previous_issues: issues,
    });
    issues = review.issues;

    const open = countOpenIssues(issues);
    const freezeCheck = validateFreeze({
      artifacts,
      issues,
      options: {
        max_design_bytes: cfg.max_design_bytes,
        strict_scopes: cfg.strict_scopes,
        ...(cfg.required_sections !== undefined
          ? { required_sections: cfg.required_sections }
          : {}),
      },
    });

    if (open === 0 && freezeCheck.ok) {
      const ts = now();
      const freeze_hash = computeFreezeHash(artifacts, issues);
      const taskIds = artifacts.task_dag.tasks.map((t) => t.id);
      const tasks = materializePlanTasks(run.id, artifacts.task_dag.tasks);
      const plan = buildPlan({
        id: planId,
        run_id: run.id,
        revision,
        status: "frozen",
        issues,
        task_ids: taskIds,
        created_at: createdAt,
        updated_at: ts,
        freeze_hash,
        frozen_at: ts,
      });
      run = transitionRunPhase(run, "PlanConsensus", { updated_at: ts });
      run = {
        ...run,
        plan_id: plan.id,
      };
      return {
        run,
        result: {
          status: "frozen",
          plan,
          artifacts,
          tasks,
          rounds,
          freeze_hash,
        },
      };
    }

    if (rounds >= cfg.max_rounds) {
      const ts = now();
      const taskIds = artifacts.task_dag.tasks.map((t) => t.id);
      const tasks = materializePlanTasks(run.id, artifacts.task_dag.tasks);
      const plan = buildPlan({
        id: planId,
        run_id: run.id,
        revision,
        status: "in_review",
        issues,
        task_ids: taskIds,
        created_at: createdAt,
        updated_at: ts,
      });
      return {
        run,
        result: {
          status: "max_rounds",
          plan,
          artifacts,
          tasks,
          rounds,
          open_issues: open,
          validation_errors: freezeCheck.errors,
        },
      };
    }

    // Revise
    revision += 1;
    const writeN = await writer.write({
      idea,
      run_id: run.id,
      revision,
      previous: artifacts,
      open_issues: issues.filter(
        (i) => i.status === "open" || i.status === "needs-user-input",
      ),
      ...(prior_plan !== undefined ? { prior_plan } : {}),
    });
    artifacts = writeN.artifacts;
    issues = applyIssueUpdates(issues, writeN.issue_updates, now());
  }
}

/**
 * Force-approve residual: re-label open/needs-user-input as wontfix with
 * response "force_approve residual", then freeze if validators otherwise pass.
 * Used when plan_max_rounds gate chooses force_approve.
 */
export function forceApproveResidual(
  issues: readonly PlanIssue[],
  now: string = new Date().toISOString(),
): PlanIssue[] {
  return issues.map((i) => {
    if (i.status === "open" || i.status === "needs-user-input") {
      return transitionPlanIssue(i, "wontfix", {
        response: "force_approve residual",
        updated_at: now,
      });
    }
    return i;
  });
}
