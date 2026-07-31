/**
 * Agy first-class adapter.
 * Binary candidates may miss PATH — bind via config binary. Model flag best-effort.
 */

import {
  createCodingAdapterForId,
  type CodingAdapterOptions,
  type CodingCliAdapter,
} from "../coding/adapter.js";
import type { AdapterRegistration } from "../registry/types.js";
import { CODING_PROFILES } from "../coding/profiles.js";
import { codingCapabilities, DEFAULT_TIER_MAPS } from "../registry/catalog.js";

export const AGY_PROFILE = CODING_PROFILES.agy;

export function agyRegistration(
  overrides: Partial<AdapterRegistration> = {},
): AdapterRegistration {
  const { id: _id, ...rest } = overrides;
  void _id;
  return {
    id: "agy",
    display_name: AGY_PROFILE.display_name,
    binary: "agy",
    binary_path: "/bin/agy",
    enabled: true,
    source: "builtin",
    candidates: ["agy"],
    capabilities: codingCapabilities({
      tier_map: { ...DEFAULT_TIER_MAPS.agy },
      usage_reporting: "none",
    }),
    start_template: AGY_PROFILE.default_start_template,
    unbound: false,
    ...rest,
  };
}

export function createAgyAdapter(
  registration: AdapterRegistration = agyRegistration(),
  options: Omit<CodingAdapterOptions, "registration" | "profile"> = {},
): CodingCliAdapter {
  return createCodingAdapterForId("agy", registration, options);
}
