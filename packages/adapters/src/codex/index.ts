/**
 * OpenAI Codex CLI first-class adapter.
 * Invoke: codex exec --model {model} {prompt_file}
 */

import {
  createCodingAdapterForId,
  type CodingAdapterOptions,
  type CodingCliAdapter,
} from "../coding/adapter.js";
import type { AdapterRegistration } from "../registry/types.js";
import { CODING_PROFILES } from "../coding/profiles.js";
import { codingCapabilities, DEFAULT_TIER_MAPS } from "../registry/catalog.js";

export const CODEX_PROFILE = CODING_PROFILES.codex;

export function codexRegistration(
  overrides: Partial<AdapterRegistration> = {},
): AdapterRegistration {
  const { id: _id, ...rest } = overrides;
  void _id;
  return {
    id: "codex",
    display_name: CODEX_PROFILE.display_name,
    binary: "codex",
    binary_path: "/bin/codex",
    enabled: true,
    source: "builtin",
    capabilities: codingCapabilities({
      tier_map: { ...DEFAULT_TIER_MAPS.codex },
      usage_reporting: "tokens",
    }),
    start_template: CODEX_PROFILE.default_start_template,
    unbound: false,
    ...rest,
  };
}

export function createCodexAdapter(
  registration: AdapterRegistration = codexRegistration(),
  options: Omit<CodingAdapterOptions, "registration" | "profile"> = {},
): CodingCliAdapter {
  return createCodingAdapterForId("codex", registration, options);
}
