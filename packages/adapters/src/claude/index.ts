/**
 * Claude Code first-class adapter.
 * Model: --model; print + bypassPermissions for non-interactive; optional --effort.
 */

import {
  createCodingAdapterForId,
  type CodingAdapterOptions,
  type CodingCliAdapter,
} from "../coding/adapter.js";
import type { AdapterRegistration } from "../registry/types.js";
import { CODING_PROFILES } from "../coding/profiles.js";
import { codingCapabilities, DEFAULT_TIER_MAPS } from "../registry/catalog.js";

export const CLAUDE_PROFILE = CODING_PROFILES.claude;

/** Minimal registration for tests / fake mode without full registry resolve. */
export function claudeRegistration(
  overrides: Partial<AdapterRegistration> = {},
): AdapterRegistration {
  const { id: _id, ...rest } = overrides;
  void _id;
  return {
    id: "claude",
    display_name: CLAUDE_PROFILE.display_name,
    binary: "claude",
    binary_path: "/bin/claude",
    enabled: true,
    source: "builtin",
    capabilities: codingCapabilities({
      tier_map: { ...DEFAULT_TIER_MAPS.claude },
      effort_flag: true,
      usage_reporting: "tokens",
    }),
    start_template: CLAUDE_PROFILE.default_start_template,
    unbound: false,
    ...rest,
  };
}

export function createClaudeAdapter(
  registration: AdapterRegistration = claudeRegistration(),
  options: Omit<CodingAdapterOptions, "registration" | "profile"> = {},
): CodingCliAdapter {
  return createCodingAdapterForId("claude", registration, options);
}
