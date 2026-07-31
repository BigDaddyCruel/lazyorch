import { generateId } from "@lazyorch/shared";
import {
  countOpenIssues,
  transitionPlanIssue,
} from "../plan-issue.js";
import { transitionRunPhase } from "../orchestrator/run-fsm.js";
import type { Plan, PlanIssue } from "../types/plan.js";
import type { Run } from "../types/run.js";
import {
  buildPlan,
  computeFreezeHash,
  materializePlanTasks,
} from "./materialize.js";
import type { PlanReviewerPort, PlanWriterPort } from "./ports.js";
import type {
  ConsensusConfig,
  ConsensusResult,
  FreezeValidationError,
  FrozenPlanResult,
  IssueUpdate,
  PlanArtifacts,
} from "./types.js";
import { taskDrafts, validateFreeze } from "./validators.js";

export class PlanningError extends Error {
  readonly code: "invalid_phase" | "writer" | "reviewer" | "validation_failed";

  constructor(
    code: PlanningError["code"],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(
      message,
      options?.cause !== undefined ? { cause: options.cause } : undefined,
    );
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
  prior_plan?: Plan;
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

/** Issue ids currently in wontfix (for dispute detection). */
export function wontfixIssueIds(issues: readonly PlanIssue[]): Set<string> {
  return new Set(
    issues.filter((i) => i.status === "wontfix").map((i) => i.id),
  );
}

/**
 * Design rule 3: writer wontfix + reviewer re-opens same issue at
 * high/critical → plan_dispute (blocks freeze).
 */
export function detectPlanDispute(
  priorWontfix: ReadonlySet<string>,
  reviewed: readonly PlanIssue[],
): string[] {
  const disputed: string[] = [];
  for (const i of reviewed) {
    if (
      priorWontfix.has(i.id) &&
      i.status === "open" &&
      (i.severity === "high" || i.severity === "critical")
    ) {
      disputed.push(i.id);
    }
  }
  return disputed;
}

function freezeOptions(cfg: ConsensusConfig) {
  return {
    max_design_bytes: cfg.max_design_bytes,
    strict_scopes: cfg.strict_scopes,
    ...(cfg.required_sections !== undefined
      ? { required_sections: cfg.required_sections }
      : {}),
  };
}

function safeTasks(artifacts: PlanArtifacts, runId: string) {
  const drafts = taskDrafts(artifacts.task_dag);
  return {
    taskIds: drafts
      .map((t) => t.id)
      .filter((id): id is string => typeof id === "string" && id.trim() !== ""),
    tasks: materializePlanTasks(runId, drafts),
  };
}

async function callWriter(
  writer: PlanWriterPort,
  ctx: Parameters<PlanWriterPort["write"]>[0],
) {
  try {
    return await writer.write(ctx);
  } catch (e) {
    throw new PlanningError(
      "writer",
      e instanceof Error ? e.message : "Plan writer failed",
      { cause: e },
    );
  }
}

async function callReviewer(
  reviewer: PlanReviewerPort,
  ctx: Parameters<PlanReviewerPort["review"]>[0],
) {
  try {
    return await reviewer.review(ctx);
  } catch (e) {
    throw new PlanningError(
      "reviewer",
      e instanceof Error ? e.message : "Plan reviewer failed",
      { cause: e },
    );
  }
}

/**
 * Planning consensus: write → review → revise until freeze validators pass,
 * max_rounds exhausted, or a plan_dispute is detected.
 *
 * Side effects on the returned run:
 * - stays in Planning while iterating (self-edge)
 * - on freeze: Planning → PlanConsensus
 * - on max_rounds / dispute: remains Planning (caller opens gate)
 *
 * No real LLM adapters — uses injected writer/reviewer ports.
 */
export async function runConsensus(
  params: RunConsensusParams,
): Promise<{ result: ConsensusResult; run: Run }> {
  const { writer, reviewer, prior_plan } = params;
  const idea = params.idea ?? params.run.idea;
  const cfg: ConsensusConfig = { ...DEFAULT_CONFIG, ...params.config };
  const now = params.now ?? (() => new Date().toISOString());
  const planId = params.plan_id ?? prior_plan?.id ?? generateId("plan");
  const createdAt = prior_plan?.created_at ?? now();

  let run = params.run;
  if (run.phase !== "Planning" && run.phase !== "PlanConsensus") {
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
    run = transitionRunPhase(run, "Planning", { updated_at: now() });
  }

  let artifacts: PlanArtifacts;
  let issues: PlanIssue[] = [];
  let revision = 0;
  let rounds = 0;
  /** Ids marked wontfix after the latest write (dispute tracking). */
  let lastWontfix = new Set<string>();
  let pendingValidationErrors: FreezeValidationError[] = [];

  // Initial write
  revision = 1;
  const write1 = await callWriter(writer, {
    idea,
    run_id: run.id,
    revision,
    open_issues: [],
    ...(prior_plan !== undefined ? { prior_plan } : {}),
  });
  artifacts = write1.artifacts;
  issues = applyIssueUpdates([], write1.issue_updates, now());
  lastWontfix = wontfixIssueIds(issues);

  // Review / revise loop
  while (true) {
    rounds += 1;

    // Self-edge models an internal plan round
    run = transitionRunPhase(run, "Planning", { updated_at: now() });

    const review = await callReviewer(reviewer, {
      idea,
      run_id: run.id,
      revision,
      artifacts,
      previous_issues: issues,
    });
    issues = review.issues;

    // Dispute: writer wontfix + reviewer re-open high/critical
    const disputed = detectPlanDispute(lastWontfix, issues);
    if (disputed.length > 0) {
      const ts = now();
      const { taskIds, tasks } = safeTasks(artifacts, run.id);
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
          status: "dispute",
          plan,
          artifacts,
          tasks,
          rounds,
          disputed_issue_ids: disputed,
        },
      };
    }

    const freezeCheck = validateFreeze({
      artifacts,
      issues,
      options: freezeOptions(cfg),
    });

    // validateFreeze already encodes open-issue blocking; rely on ok alone
    if (freezeCheck.ok) {
      const ts = now();
      const freeze_hash = computeFreezeHash(artifacts, issues);
      const { taskIds, tasks } = safeTasks(artifacts, run.id);
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
      const { taskIds, tasks } = safeTasks(artifacts, run.id);
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
          open_issues: countOpenIssues(issues),
          validation_errors: freezeCheck.errors,
        },
      };
    }

    // Feed validator failures into revise so the writer can fix them
    pendingValidationErrors = freezeCheck.errors;

    revision += 1;
    const writeN = await callWriter(writer, {
      idea,
      run_id: run.id,
      revision,
      previous: artifacts,
      open_issues: issues.filter(
        (i) => i.status === "open" || i.status === "needs-user-input",
      ),
      validation_errors: pendingValidationErrors,
      ...(prior_plan !== undefined ? { prior_plan } : {}),
    });
    artifacts = writeN.artifacts;
    issues = applyIssueUpdates(issues, writeN.issue_updates, now());
    lastWontfix = wontfixIssueIds(issues);
  }
}

/**
 * Force-approve residual: re-label open/needs-user-input as wontfix with
 * response "force_approve residual". Does not freeze — use
 * {@link completeForceApprove} for the full gate path.
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

/** Build residual risk strings from force-approved issues. */
export function residualRisksFromIssues(
  issues: readonly PlanIssue[],
): string[] {
  return issues
    .filter(
      (i) =>
        i.status === "wontfix" && i.response === "force_approve residual",
    )
    .map(
      (i) =>
        `[${i.severity}/${i.category}] ${i.section}: ${i.description} (${i.id})`,
    );
}

export interface CompleteForceApproveParams {
  run: Run;
  artifacts: PlanArtifacts;
  issues: readonly PlanIssue[];
  plan_id: string;
  revision: number;
  created_at?: string;
  config?: Partial<ConsensusConfig>;
  now?: () => string;
  /** Pre-computed rounds for the FrozenPlanResult.rounds field. */
  rounds?: number;
}

export type CompleteForceApproveResult =
  | { ok: true; result: FrozenPlanResult; run: Run }
  | {
      ok: false;
      issues: PlanIssue[];
      residual_risks: string[];
      validation_errors: FreezeValidationError[];
      run: Run;
    };

/**
 * plan_max_rounds `force_approve` path:
 * 1. Re-label residual open issues as wontfix
 * 2. Record residual_risks on the plan
 * 3. validateFreeze; on success freeze + PlanConsensus
 */
export function completeForceApprove(
  params: CompleteForceApproveParams,
): CompleteForceApproveResult {
  const cfg: ConsensusConfig = { ...DEFAULT_CONFIG, ...params.config };
  const now = params.now ?? (() => new Date().toISOString());
  const ts = now();
  const issues = forceApproveResidual(params.issues, ts);
  const residual_risks = residualRisksFromIssues(issues);

  const freezeCheck = validateFreeze({
    artifacts: params.artifacts,
    issues,
    options: freezeOptions(cfg),
  });

  if (!freezeCheck.ok) {
    return {
      ok: false,
      issues,
      residual_risks,
      validation_errors: freezeCheck.errors,
      run: params.run,
    };
  }

  const freeze_hash = computeFreezeHash(params.artifacts, issues);
  const { taskIds, tasks } = safeTasks(params.artifacts, params.run.id);
  const plan = buildPlan({
    id: params.plan_id,
    run_id: params.run.id,
    revision: params.revision,
    status: "frozen",
    issues,
    task_ids: taskIds,
    created_at: params.created_at ?? ts,
    updated_at: ts,
    freeze_hash,
    frozen_at: ts,
    residual_risks,
  });

  let run = params.run;
  if (run.phase === "Planning") {
    run = transitionRunPhase(run, "PlanConsensus", { updated_at: ts });
  } else if (run.phase !== "PlanConsensus") {
    throw new PlanningError(
      "invalid_phase",
      `completeForceApprove requires Planning or PlanConsensus, got ${run.phase}`,
    );
  }
  run = { ...run, plan_id: plan.id };

  return {
    ok: true,
    run,
    result: {
      status: "frozen",
      plan,
      artifacts: params.artifacts,
      tasks,
      rounds: params.rounds ?? 0,
      freeze_hash,
    },
  };
}
