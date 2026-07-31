import type { SchemaVersion } from "../schema.js";

/** Coarse run lifecycle phase (run-level FSM). */
export const RUN_PHASES = [
  "Inception",
  "Planning",
  "PlanConsensus",
  "Implementing",
  "PrePR",
  "PROpen",
  "CILoop",
  "MergeReady",
  "Merged",
  "Cancelled",
  "Failed",
] as const;

export type RunPhase = (typeof RUN_PHASES)[number];

const PHASE_SET = new Set<string>(RUN_PHASES);

export function isRunPhase(value: unknown): value is RunPhase {
  return typeof value === "string" && PHASE_SET.has(value);
}

/** Linked forge PR reference for a run. */
export interface PrRef {
  number: number;
  url?: string;
  /** draft | ready | merged | closed */
  state: "draft" | "ready" | "merged" | "closed";
  head_sha?: string;
}

export interface RunQaState {
  /** Feature tip SHA when run-level QA last passed; cleared when tip moves. */
  passed_at_commit?: string;
}

/**
 * One end-to-end lifecycle attempt for an idea.
 * ID: `run_…`
 */
export interface Run {
  schema_version: SchemaVersion;
  id: string;
  project_id: string;
  phase: RunPhase;
  idea: string;
  created_at: string;
  updated_at: string;
  feature_branch?: string;
  feature_tip_sha?: string;
  plan_id?: string;
  pr_ref?: PrRef;
  qa?: RunQaState;
  cancelled_reason?: string;
  failed_reason?: string;
}
