/**
 * Planning phase orchestration: team agents + router + consensus + plan gates.
 * Does not implement the Implementing phase (PR-16).
 */

import type { RouteResult } from "../models/types.js";
import {
  mayCollapsePlanWriterAndReviewer,
  mintPlanAgent,
  resolveTeamMode,
} from "../team/index.js";
import type { Agent } from "../types/agent.js";
import type { Gate } from "../types/gate.js";
import type { Plan } from "../types/plan.js";
import type { Run } from "../types/run.js";
import type { TeamMode } from "../types/team.js";
import {
  runConsensus,
  type RunConsensusParams,
} from "./consensus.js";
import {
  autoAdvanceAfterPlanFreeze,
  createPlanApproveGate,
  createPlanDisputeGate,
  createPlanMaxRoundsGate,
  shouldOpenPlanApproveGate,
} from "./gates.js";
import { SessionPlanReviewer, SessionPlanWriter } from "./handlers.js";
import type {
  PlanningRoutingOptions,
  PlanningSessionPort,
} from "./ports.js";
import type { ConsensusConfig, ConsensusResult } from "./types.js";

export interface RunPlanningPhaseParams {
  run: Run;
  /** Injectable session runner (fake for E2E freeze without live LLMs). */
  session: PlanningSessionPort;
  /** Project root / cwd for sessions. */
  cwd: string;
  idea?: string;
  mode?: TeamMode;
  /** When true (default), open plan_approve after freeze if gates allow. */
  gates?: {
    plan_approve?: boolean;
    task_approve?: boolean;
    merge?: boolean;
  };
  routing?: PlanningRoutingOptions;
  consensus?: Partial<ConsensusConfig>;
  plan_id?: string;
  prior_plan?: Plan;
  now?: () => string;
  nextAgentId?: () => string;
  nextGateId?: () => string;
  /** Prefer collapse writer=reviewer agent only when mode allows solo. */
  collapse_writer_reviewer?: boolean;
  preferred_adapters_by_role?: Partial<
    Record<"plan_writer" | "plan_reviewer", readonly string[]>
  >;
}

export interface PlanningPhaseResult {
  result: ConsensusResult;
  run: Run;
  /**
   * Gates opened by this phase (pending).
   * Empty when frozen + plan_approve off (run auto-advanced to Implementing).
   */
  gates: Gate[];
  writer: SessionPlanWriter;
  reviewer: SessionPlanReviewer;
  writer_agent: Agent;
  reviewer_agent: Agent;
  writer_route: RouteResult | undefined;
  reviewer_route: RouteResult | undefined;
  /**
   * True when writer and reviewer share the same agent id (solo collapse).
   * reviewer_agent is a plan_reviewer-labeled view of the same id for
   * observability; handlers still route by hard-coded role.
   */
  collapsed: boolean;
}

/**
 * Wire planning: mint plan agents → session-backed ports → consensus → plan gates.
 *
 * On freeze:
 * - plan_approve enabled (default): open plan_approve, stay PlanConsensus
 * - plan_approve disabled: auto PlanConsensus → Implementing (no gate)
 * On max_rounds:
 * - open plan_max_rounds
 * On dispute:
 * - open plan_dispute
 */
export async function runPlanningPhase(
  params: RunPlanningPhaseParams,
): Promise<PlanningPhaseResult> {
  const mode = params.mode ?? "full";
  const limits = resolveTeamMode({
    mode,
    ...(params.gates !== undefined ? { gates: params.gates } : {}),
  });

  const collapse =
    (params.collapse_writer_reviewer ?? false) &&
    mayCollapsePlanWriterAndReviewer(mode);

  const writer_agent = mintPlanAgent({
    run_id: params.run.id,
    role: "plan_writer",
    ...(params.preferred_adapters_by_role?.plan_writer !== undefined
      ? {
          preferred_adapters: params.preferred_adapters_by_role.plan_writer,
        }
      : {}),
    ...(params.now !== undefined ? { now: params.now() } : {}),
    ...(params.nextAgentId !== undefined
      ? { nextAgentId: params.nextAgentId }
      : {}),
  });

  // Solo collapse: same agent id for writer + reviewer (design rule 1).
  // reviewer_agent is a plan_reviewer-labeled view so role metadata is correct
  // for persistence/observability while id stays shared.
  const reviewer_agent: Agent = collapse
    ? {
        ...writer_agent,
        role: "plan_reviewer",
        labels: ["plan-reviewer", "plan_reviewer", "plan-review"],
      }
    : mintPlanAgent({
        run_id: params.run.id,
        role: "plan_reviewer",
        ...(params.preferred_adapters_by_role?.plan_reviewer !== undefined
          ? {
              preferred_adapters:
                params.preferred_adapters_by_role.plan_reviewer,
            }
          : {}),
        ...(params.now !== undefined ? { now: params.now() } : {}),
        ...(params.nextAgentId !== undefined
          ? { nextAgentId: params.nextAgentId }
          : {}),
      });

  const routing: PlanningRoutingOptions = {
    ...(params.routing ?? {}),
  };
  if (params.preferred_adapters_by_role) {
    routing.preferred_adapters_by_role = {
      ...(routing.preferred_adapters_by_role ?? {}),
      ...params.preferred_adapters_by_role,
    };
  }

  const writer = new SessionPlanWriter({
    session: params.session,
    agent: writer_agent,
    cwd: params.cwd,
    routing,
  });
  const reviewer = new SessionPlanReviewer({
    session: params.session,
    agent: reviewer_agent,
    cwd: params.cwd,
    routing,
  });

  const consensusParams: RunConsensusParams = {
    run: params.run,
    writer,
    reviewer,
  };
  if (params.idea !== undefined) consensusParams.idea = params.idea;
  if (params.consensus !== undefined) consensusParams.config = params.consensus;
  if (params.plan_id !== undefined) consensusParams.plan_id = params.plan_id;
  if (params.prior_plan !== undefined) {
    consensusParams.prior_plan = params.prior_plan;
  }
  if (params.now !== undefined) consensusParams.now = params.now;

  const { result, run: consensusRun } = await runConsensus(consensusParams);

  const gateOpts: {
    plan_approve: boolean;
    now?: () => string;
    nextId?: () => string;
  } = {
    plan_approve: shouldOpenPlanApproveGate(limits.gates),
  };
  if (params.now !== undefined) gateOpts.now = params.now;
  if (params.nextGateId !== undefined) gateOpts.nextId = params.nextGateId;

  const { gates, run } = applyPostConsensusGates(result, consensusRun, gateOpts);

  return {
    result,
    run,
    gates,
    writer,
    reviewer,
    writer_agent,
    reviewer_agent,
    writer_route: writer.lastRoute,
    reviewer_route: reviewer.lastRoute,
    collapsed: collapse,
  };
}

/**
 * After consensus: open the right gate(s) and/or auto-advance when plan_approve is off.
 */
export function applyPostConsensusGates(
  result: ConsensusResult,
  run: Run,
  opts: {
    plan_approve: boolean;
    now?: () => string;
    nextId?: () => string;
  },
): { gates: Gate[]; run: Run } {
  const base = {
    run_id: run.id,
    plan_id: result.plan.id,
    revision: result.plan.revision,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.nextId !== undefined ? { nextId: opts.nextId } : {}),
  };

  if (result.status === "frozen") {
    if (!opts.plan_approve) {
      // Auto path: PlanConsensus → Implementing (no pending gate).
      const advanced = autoAdvanceAfterPlanFreeze(run, {
        ...(opts.now !== undefined ? { now: opts.now } : {}),
      });
      return { gates: [], run: advanced };
    }
    return {
      run,
      gates: [
        createPlanApproveGate({
          ...base,
          freeze_hash: result.freeze_hash,
          ...(result.plan.residual_risks !== undefined
            ? { residual_risks: result.plan.residual_risks }
            : {}),
        }),
      ],
    };
  }

  if (result.status === "max_rounds") {
    return {
      run,
      gates: [
        createPlanMaxRoundsGate({
          ...base,
          rounds: result.rounds,
          open_issues: result.open_issues,
          validation_errors: result.validation_errors,
        }),
      ],
    };
  }

  // dispute
  return {
    run,
    gates: [
      createPlanDisputeGate({
        ...base,
        disputed_issue_ids: result.disputed_issue_ids,
      }),
    ],
  };
}
