import type { SchemaVersion } from "../schema.js";
import type { ModelTier } from "./model-tier.js";

export const AGENT_ROLES = [
  "lead",
  "worker",
  "reviewer",
  "qa",
  "plan_writer",
  "plan_reviewer",
] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];

const ROLE_SET = new Set<string>(AGENT_ROLES);

export function isAgentRole(value: unknown): value is AgentRole {
  return typeof value === "string" && ROLE_SET.has(value);
}

/**
 * Agent config/instance for a run (role + preferred adapters + policies).
 * A session is a running process; this is the durable entity.
 * ID: `agt_…`
 */
export interface Agent {
  schema_version: SchemaVersion;
  id: string;
  run_id: string;
  role: AgentRole;
  /** Display / template tags, e.g. fullstack-dev */
  labels: string[];
  preferred_adapters: string[];
  /** Optional default tier preference for this agent config */
  default_tier?: ModelTier;
  created_at: string;
}
