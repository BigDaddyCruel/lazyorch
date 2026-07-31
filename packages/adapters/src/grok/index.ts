/**
 * Grok CLI first-class adapter.
 * Candidates: grok, grok-cli, xai (config override). Model: --model.
 */

import {
  createCodingAdapterForId,
  type CodingAdapterOptions,
  type CodingCliAdapter,
} from "../coding/adapter.js";
import type { AdapterRegistration } from "../registry/types.js";
import { CODING_PROFILES } from "../coding/profiles.js";
import { codingCapabilities, DEFAULT_TIER_MAPS } from "../registry/catalog.js";

export const GROK_PROFILE = CODING_PROFILES.grok;

export function grokRegistration(
  overrides: Partial<AdapterRegistration> = {},
): AdapterRegistration {
  const { id: _id, ...rest } = overrides;
  void _id;
  return {
    id: "grok",
    display_name: GROK_PROFILE.display_name,
    binary: "grok",
    binary_path: "/bin/grok",
    enabled: true,
    source: "builtin",
    candidates: ["grok", "grok-cli", "xai"],
    capabilities: codingCapabilities({
      tier_map: { ...DEFAULT_TIER_MAPS.grok },
      usage_reporting: "tokens",
    }),
    start_template: GROK_PROFILE.default_start_template,
    unbound: false,
    ...rest,
  };
}

export function createGrokAdapter(
  registration: AdapterRegistration = grokRegistration(),
  options: Omit<CodingAdapterOptions, "registration" | "profile"> = {},
): CodingCliAdapter {
  return createCodingAdapterForId("grok", registration, options);
}
