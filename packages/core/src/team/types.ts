/**
 * Team manager types — role templates, ephemeral session policy, mode limits.
 * PR-13 / KD-3 / KD-25 / KD-26 / KD-35.
 */

import type { AgentRole } from "../types/agent.js";
import type { ModelTier } from "../types/model-tier.js";
import type { TeamMode } from "../types/team.js";

export type SessionKindPreference = "llm" | "deterministic";
export type ApprovalPolicy = "auto" | "suggest" | "manual";

/**
 * Role template: named agent blueprint used when minting agents for a run.
 * Template `id` appears in team.worker_templates / lead_template / etc.
 * `labels` are tags matched against task.role_affinity.
 */
export interface RoleTemplate {
  /** Stable template id, e.g. fullstack-dev, architect-lead. */
  id: string;
  role: AgentRole;
  /** Matching tags (includes id by convention). */
  labels: string[];
  /** Adapter preference for router pickAdapter (coding first; shell never coding fallback). */
  preferred_adapters: string[];
  /** Built-in skill ids bound for session materialization. */
  skills: string[];
  default_tier?: ModelTier;
  /** LLM vs deterministic/shell session path preference. */
  session_kind: SessionKindPreference;
  approval_policy: ApprovalPolicy;
  /** Optional human-readable description. */
  description?: string;
}

/** Ephemeral session policy for lead / reviewer / QA (KD-26, KD-35). */
export interface EphemeralSessionPolicy {
  mode: "ephemeral";
  /** Max idle ms before clean exit when work queue is empty (reviewer default 60s). */
  idle_exit_ms: number;
  /** Crash/timeout restarts per rolling hour before human_intervention. */
  max_restarts_per_hour: number;
}

/** Effective caps after mode resolution (full vs solo). */
export interface EffectiveTeamLimits {
  mode: TeamMode;
  max_workers: number;
  min_workers: number;
  min_reviewers: number;
  max_reviewers: number;
  min_qa: number;
  max_qa: number;
  /** Compensating gates forced true in solo (KD-25). */
  gates: {
    task_approve: boolean;
    plan_approve: boolean;
    merge: boolean;
  };
  /** Plan writer may equal plan reviewer only in solo. */
  allow_plan_writer_eq_reviewer: boolean;
}

/** Inputs for building a run team from operator config. */
export interface BuildTeamInput {
  run_id: string;
  mode: TeamMode;
  lead_template?: string;
  reviewer_templates?: readonly string[];
  qa_templates?: readonly string[];
  worker_templates?: readonly string[];
  min_reviewers?: number;
  max_reviewers?: number;
  min_qa?: number;
  max_qa?: number;
  min_workers?: number;
  max_workers?: number;
  /**
   * Operator gate flags (full mode preserves; solo forces task/plan/merge true).
   * When omitted, full mode uses design defaults (task_approve false, plan/merge true).
   */
  gates?: {
    task_approve?: boolean;
    plan_approve?: boolean;
    merge?: boolean;
  };
  /** Override preferred adapters by role (optional). */
  preferred_adapters_by_role?: Partial<Record<AgentRole, readonly string[]>>;
  /** ISO timestamp; defaults to now. */
  now?: string;
  /** Id factory for agents (tests). */
  nextAgentId?: () => string;
}

export interface BuiltTeam {
  team: import("../types/team.js").Team;
  agents: import("../types/agent.js").Agent[];
  limits: EffectiveTeamLimits;
  /** Template ids selected for lead / seeded reviewers / qa / worker pool labels. */
  selected_templates: {
    lead: string;
    reviewers: string[];
    qa: string[];
    workers: string[];
  };
}
