/**
 * Builtin first-class adapter catalog (claude, codex, agy, grok, shell).
 * Candidates + capability defaults. Coding start depth is PR-09 (CodingCliAdapter).
 *
 * Default start_template strings for coding ids come from CODING_PROFILES
 * (single source of truth — do not hardcode templates here).
 */

import type { ModelTier } from "@lazyorch/shared";
import { CODING_PROFILES } from "../coding/profiles.js";
import type {
  AdapterCapabilities,
  BuiltinCatalogEntry,
  CapabilityMatrixFlags,
} from "./types.js";

const EMPTY_TIER_MAP: Partial<Record<ModelTier, string>> = {};

/** Shared thin defaults for coding CLIs (models filled by config / probe later). */
export function codingCapabilities(
  overrides: Partial<AdapterCapabilities> = {},
): AdapterCapabilities {
  return {
    models: overrides.models ?? [],
    tier_map: overrides.tier_map ?? { ...EMPTY_TIER_MAP },
    streaming: overrides.streaming ?? false,
    worktree_ok: overrides.worktree_ok ?? true,
    usage_reporting: overrides.usage_reporting ?? "none",
    ...(overrides.effort_flag !== undefined
      ? { effort_flag: overrides.effort_flag }
      : {}),
    ...(overrides.max_concurrent_hint !== undefined
      ? { max_concurrent_hint: overrides.max_concurrent_hint }
      : {}),
  };
}

export function shellCapabilities(): AdapterCapabilities {
  return {
    models: [],
    tier_map: {},
    streaming: false,
    worktree_ok: true,
    usage_reporting: "none",
  };
}

/**
 * Design default tier maps (config adapters.models may override).
 * Thin: concrete ids are hints for the router; adapters accept whatever the CLI takes.
 */
export const DEFAULT_TIER_MAPS: Record<
  string,
  Partial<Record<ModelTier, string>>
> = {
  claude: {
    nano: "claude-haiku-4-5",
    small: "claude-haiku-4-5",
    medium: "claude-sonnet-4-6",
    large: "claude-sonnet-4-6",
    xlarge: "claude-opus-4-6",
  },
  codex: {
    small: "o4-mini",
    medium: "o4-mini",
    large: "gpt-5",
    xlarge: "gpt-5",
  },
  grok: {
    small: "grok-3-mini",
    medium: "grok-3",
    large: "grok-3",
    xlarge: "grok-4",
  },
  agy: {},
};

/** First-class builtin ids in stable preference-friendly order. */
export const BUILTIN_ADAPTER_IDS = [
  "claude",
  "codex",
  "agy",
  "grok",
  "shell",
] as const;

export type BuiltinAdapterId = (typeof BUILTIN_ADAPTER_IDS)[number];

export function isBuiltinAdapterId(id: string): id is BuiltinAdapterId {
  return (BUILTIN_ADAPTER_IDS as readonly string[]).includes(id);
}

/**
 * Builtin catalog — discovery candidates + thin capability matrix defaults.
 */
export const BUILTIN_CATALOG: readonly BuiltinCatalogEntry[] = [
  {
    id: "claude",
    display_name: "Claude Code",
    candidates: ["claude"],
    kind: "llm",
    version_args: ["--version"],
    capabilities: codingCapabilities({
      tier_map: { ...DEFAULT_TIER_MAPS.claude },
      effort_flag: true,
      usage_reporting: "tokens_and_cost",
    }),
    // Single source: CODING_PROFILES (programmatic argv + custom-template detect).
    start_template: CODING_PROFILES.claude.default_start_template,
  },
  {
    id: "codex",
    display_name: "OpenAI Codex CLI",
    candidates: ["codex"],
    kind: "llm",
    version_args: ["--version"],
    capabilities: codingCapabilities({
      tier_map: { ...DEFAULT_TIER_MAPS.codex },
      usage_reporting: "tokens",
    }),
    start_template: CODING_PROFILES.codex.default_start_template,
  },
  {
    id: "agy",
    display_name: "Agy",
    candidates: ["agy"],
    kind: "llm",
    version_args: ["--version"],
    capabilities: codingCapabilities({
      tier_map: { ...DEFAULT_TIER_MAPS.agy },
      usage_reporting: "none",
    }),
    // Best-effort model flag; bind via config binary when PATH fails.
    start_template: CODING_PROFILES.agy.default_start_template,
  },
  {
    id: "grok",
    display_name: "Grok CLI",
    candidates: ["grok", "grok-cli", "xai"],
    kind: "llm",
    version_args: ["--version"],
    capabilities: codingCapabilities({
      tier_map: { ...DEFAULT_TIER_MAPS.grok },
      usage_reporting: "tokens",
    }),
    start_template: CODING_PROFILES.grok.default_start_template,
  },
  {
    id: "shell",
    display_name: "Shell (deterministic)",
    candidates: [],
    kind: "deterministic",
    version_args: [],
    capabilities: shellCapabilities(),
  },
];

export function getBuiltinCatalogEntry(
  id: string,
): BuiltinCatalogEntry | undefined {
  return BUILTIN_CATALOG.find((e) => e.id === id);
}

/** Capability matrix flags per design thin vs deep table. */
export function matrixFlagsFor(
  id: string,
  kind: "llm" | "deterministic" | "generic",
): CapabilityMatrixFlags {
  if (id === "shell" || kind === "deterministic") {
    return {
      doctor: true,
      start: true,
      cancel: true,
      model_flag: "n/a",
      usage_parse: "none",
      worktree_cwd: true,
    };
  }
  if (kind === "generic") {
    return {
      doctor: true,
      start: true,
      cancel: true,
      model_flag: "template",
      usage_parse: "none",
      worktree_cwd: true,
    };
  }
  // First-class LLM builtins — start/cancel required; usage thin OK.
  const modelFlag =
    id === "agy" ? ("best-effort" as const) : true;
  return {
    doctor: true,
    start: true,
    cancel: true,
    model_flag: modelFlag,
    usage_parse: "best-effort",
    worktree_cwd: true,
  };
}
