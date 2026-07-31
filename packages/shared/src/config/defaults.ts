import type { LazyorchConfigInput } from "./schema.js";
import { defaultConfig } from "./load.js";
import type { LazyorchConfig } from "./schema.js";

/**
 * Design-doc default operator config (interactive).
 * Defaults: max_concurrent_agents 8, max_workers 4, reserve_slots.lead 1,
 * min_reviewers/min_qa 1, gates.plan_approve/merge true, timeout_action none.
 * In CI, pass `{ ci: true }` to `defaultConfig` for timeout_action fail (KD-44).
 */
export const DEFAULT_CONFIG_OVERRIDES: LazyorchConfigInput = {
  project: {
    name: "project",
    default_branch: "main",
  },
  adapters: {
    default: "claude",
    preference_order: ["claude", "codex", "grok", "agy", "shell"],
  },
  elasticity: {
    max_workers: 4,
    min_workers: 0,
  },
  scheduling: {
    max_concurrent_agents: 8,
  },
  reserve_slots: {
    lead: 1,
  },
  team: {
    mode: "full",
    min_reviewers: 1,
    max_reviewers: 2,
    min_qa: 1,
    max_qa: 2,
  },
  gates: {
    plan_approve: true,
    merge: true,
    plan_reject_action: "cancel",
    timeout_action: "none",
  },
};

/** Fully resolved default config for interactive use. */
export function createDefaultConfig(
  projectName = "project",
  options: { ci?: boolean } = {},
): LazyorchConfig {
  return defaultConfig(
    {
      ...DEFAULT_CONFIG_OVERRIDES,
      project: {
        name: projectName,
        default_branch: "main",
      },
    },
    { ci: options.ci === true, enforcePacking: true },
  );
}
