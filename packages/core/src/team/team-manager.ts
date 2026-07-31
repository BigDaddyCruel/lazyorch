/**
 * Team manager — build run team + agents from role templates and mode (PR-13).
 */

import { generateId } from "@lazyorch/shared";
import { SCHEMA_VERSION } from "../schema.js";
import type { Agent } from "../types/agent.js";
import type { Team } from "../types/team.js";
import { resolveTeamMode } from "./mode.js";
import {
  defaultTemplateIdForRole,
  resolveRoleTemplate,
} from "./role-templates.js";
import type {
  BuildTeamInput,
  BuiltTeam,
  EffectiveTeamLimits,
} from "./types.js";

function nowIso(now?: string): string {
  return now ?? new Date().toISOString();
}

/**
 * Build durable Team + Agent configs for a run.
 *
 * full mode: lead + min_reviewers + min_qa agent configs (workers elastic — not pre-minted).
 * solo mode: lead only; workers/reviewers/qa caps forced to 0.
 *
 * Agent configs hold zero slots until a session starts (ephemeral).
 */
export function buildTeam(input: BuildTeamInput): BuiltTeam {
  const modeInput: Parameters<typeof resolveTeamMode>[0] = {
    mode: input.mode,
  };
  if (input.min_workers !== undefined) modeInput.min_workers = input.min_workers;
  if (input.max_workers !== undefined) modeInput.max_workers = input.max_workers;
  if (input.min_reviewers !== undefined) {
    modeInput.min_reviewers = input.min_reviewers;
  }
  if (input.max_reviewers !== undefined) {
    modeInput.max_reviewers = input.max_reviewers;
  }
  if (input.min_qa !== undefined) modeInput.min_qa = input.min_qa;
  if (input.max_qa !== undefined) modeInput.max_qa = input.max_qa;
  if (input.gates !== undefined) modeInput.gates = input.gates;
  const limits = resolveTeamMode(modeInput);

  const nextId = input.nextAgentId ?? (() => generateId("agt"));
  const ts = nowIso(input.now);
  const agents: Agent[] = [];

  const leadTemplateId =
    input.lead_template ?? defaultTemplateIdForRole("lead");
  const leadTpl = resolveRoleTemplate(
    leadTemplateId,
    "lead",
    input.preferred_adapters_by_role,
  );
  const lead: Agent = {
    schema_version: SCHEMA_VERSION,
    id: nextId(),
    run_id: input.run_id,
    role: "lead",
    labels: [...leadTpl.labels],
    preferred_adapters: [...leadTpl.preferred_adapters],
    created_at: ts,
  };
  if (leadTpl.default_tier !== undefined) {
    lead.default_tier = leadTpl.default_tier;
  }
  agents.push(lead);

  const reviewerTemplateIds =
    input.reviewer_templates && input.reviewer_templates.length > 0
      ? [...input.reviewer_templates]
      : [defaultTemplateIdForRole("reviewer")];
  const qaTemplateIds =
    input.qa_templates && input.qa_templates.length > 0
      ? [...input.qa_templates]
      : [defaultTemplateIdForRole("qa")];
  const workerTemplateIds =
    input.worker_templates && input.worker_templates.length > 0
      ? [...input.worker_templates]
      : [
          defaultTemplateIdForRole("worker"),
          "backend-dev",
          "frontend-dev",
        ];

  const selectedReviewers: string[] = [];
  // Seed min_reviewers agent configs (full mode only)
  for (let i = 0; i < limits.min_reviewers; i++) {
    const tid = reviewerTemplateIds[i % reviewerTemplateIds.length]!;
    selectedReviewers.push(tid);
    const tpl = resolveRoleTemplate(
      tid,
      "reviewer",
      input.preferred_adapters_by_role,
    );
    const ag: Agent = {
      schema_version: SCHEMA_VERSION,
      id: nextId(),
      run_id: input.run_id,
      role: "reviewer",
      labels: [...tpl.labels],
      preferred_adapters: [...tpl.preferred_adapters],
      created_at: ts,
    };
    if (tpl.default_tier !== undefined) ag.default_tier = tpl.default_tier;
    agents.push(ag);
  }

  const selectedQa: string[] = [];
  for (let i = 0; i < limits.min_qa; i++) {
    const tid = qaTemplateIds[i % qaTemplateIds.length]!;
    selectedQa.push(tid);
    const tpl = resolveRoleTemplate(
      tid,
      "qa",
      input.preferred_adapters_by_role,
    );
    const ag: Agent = {
      schema_version: SCHEMA_VERSION,
      id: nextId(),
      run_id: input.run_id,
      role: "qa",
      labels: [...tpl.labels],
      preferred_adapters: [...tpl.preferred_adapters],
      created_at: ts,
    };
    if (tpl.default_tier !== undefined) ag.default_tier = tpl.default_tier;
    agents.push(ag);
  }

  const team: Team = {
    schema_version: SCHEMA_VERSION,
    run_id: input.run_id,
    mode: limits.mode,
    lead_agent_id: lead.id,
    agent_ids: agents.map((a) => a.id),
    updated_at: ts,
  };

  return {
    team,
    agents,
    limits,
    selected_templates: {
      lead: leadTemplateId,
      reviewers: selectedReviewers,
      qa: selectedQa,
      workers: workerTemplateIds,
    },
  };
}

/**
 * Mint a worker agent config from a matched template (elastic spawn / assign).
 */
export function mintWorkerAgent(input: {
  run_id: string;
  template_id: string;
  preferred_adapters?: readonly string[];
  now?: string;
  nextAgentId?: () => string;
}): Agent {
  const tpl = resolveRoleTemplate(input.template_id, "worker");
  const adapters =
    input.preferred_adapters && input.preferred_adapters.length > 0
      ? [...input.preferred_adapters]
      : [...tpl.preferred_adapters];
  const agent: Agent = {
    schema_version: SCHEMA_VERSION,
    id: input.nextAgentId?.() ?? generateId("agt"),
    run_id: input.run_id,
    role: "worker",
    labels: [...tpl.labels],
    preferred_adapters: adapters,
    created_at: nowIso(input.now),
  };
  if (tpl.default_tier !== undefined) agent.default_tier = tpl.default_tier;
  return agent;
}

/**
 * Mint a plan_writer or plan_reviewer agent (Planning phase — PR-15).
 * Distinct agents by default; solo may collapse them (same id) at the caller.
 */
export function mintPlanAgent(input: {
  run_id: string;
  role: "plan_writer" | "plan_reviewer";
  template_id?: string;
  preferred_adapters?: readonly string[];
  now?: string;
  nextAgentId?: () => string;
}): Agent {
  const tid = input.template_id ?? defaultTemplateIdForRole(input.role);
  const tpl = resolveRoleTemplate(tid, input.role);
  const adapters =
    input.preferred_adapters && input.preferred_adapters.length > 0
      ? [...input.preferred_adapters]
      : [...tpl.preferred_adapters];
  const agent: Agent = {
    schema_version: SCHEMA_VERSION,
    id: input.nextAgentId?.() ?? generateId("agt"),
    run_id: input.run_id,
    role: input.role,
    labels: [...tpl.labels],
    preferred_adapters: adapters,
    created_at: nowIso(input.now),
  };
  if (tpl.default_tier !== undefined) agent.default_tier = tpl.default_tier;
  return agent;
}

/** Look up agent by id. */
export function findAgent(
  agents: readonly Agent[],
  id: string,
): Agent | undefined {
  return agents.find((a) => a.id === id);
}

/** Agents with a given role. */
export function agentsByRole(
  agents: readonly Agent[],
  role: Agent["role"],
): Agent[] {
  return agents.filter((a) => a.role === role);
}

/**
 * Preferred adapters for routing: agent.preferred_adapters if present,
 * else role default from team manager.
 */
export function preferredAdaptersForAgent(
  agent: Agent | undefined,
  role: Agent["role"],
  roleDefaults?: Partial<Record<Agent["role"], readonly string[]>>,
): string[] {
  if (agent?.preferred_adapters && agent.preferred_adapters.length > 0) {
    return [...agent.preferred_adapters];
  }
  const tpl = resolveRoleTemplate(
    defaultTemplateIdForRole(role),
    role,
    roleDefaults,
  );
  return [...tpl.preferred_adapters];
}

export type { EffectiveTeamLimits, Team };
