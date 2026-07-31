import type { SchemaVersion } from "../schema.js";

export const TEAM_MODES = ["full", "solo"] as const;
export type TeamMode = (typeof TEAM_MODES)[number];

/**
 * Lead + workers + review/QA for a run, subject to team.mode.
 * Stored as runs/<run_id>/team.json.
 */
export interface Team {
  schema_version: SchemaVersion;
  run_id: string;
  mode: TeamMode;
  lead_agent_id?: string;
  agent_ids: string[];
  updated_at: string;
}
