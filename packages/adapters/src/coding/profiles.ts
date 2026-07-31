/**
 * Vendor profiles for first-class coding adapters (PR-09).
 * Model flag templates + invoke argv shape; usage parse is thin/best-effort.
 */

import type { EffortLevel } from "../types.js";
import type { UsageReporting } from "../registry/types.js";

export const FIRST_CLASS_CODING_IDS = [
  "claude",
  "codex",
  "agy",
  "grok",
] as const;

export type FirstClassCodingId = (typeof FIRST_CLASS_CODING_IDS)[number];

export function isFirstClassCodingId(id: string): id is FirstClassCodingId {
  return (FIRST_CLASS_CODING_IDS as readonly string[]).includes(id);
}

/**
 * How the adapter builds argv for start.
 * Placeholders in templates: {model} {effort} {prompt_file}
 */
export interface CodingAdapterProfile {
  id: FirstClassCodingId;
  display_name: string;
  /**
   * Model flag tokens (whitespace-split after {model} substitute).
   * Empty string = omit model flag (agy best-effort may still inject when model set).
   */
  model_flag_template: string;
  /** When false, model flag is best-effort (agy): only add if model is non-empty. */
  model_flag_required: boolean;
  /**
   * Fixed args inserted after binary and before model flag
   * (e.g. codex `exec`).
   */
  prefix_args: readonly string[];
  /**
   * Fixed args after model flag and before prompt
   * (e.g. claude `--print --permission-mode bypassPermissions`).
   */
  mid_args: readonly string[];
  /**
   * Effort flag template when session.effort set and registration
   * capabilities.effort_flag is true. Placeholders: {effort}
   */
  effort_flag_template?: string;
  /** Prompt delivery: positional path arg (v1 default for all builtins). */
  prompt_style: "positional";
  usage_reporting: UsageReporting;
  /** Catalog start_template (documentation + generic fallback). */
  default_start_template: string;
}

const EFFORT_VALUES: readonly EffortLevel[] = ["low", "medium", "high"];

export function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_VALUES as readonly string[]).includes(value);
}

export const CODING_PROFILES: Record<
  FirstClassCodingId,
  CodingAdapterProfile
> = {
  claude: {
    id: "claude",
    display_name: "Claude Code",
    model_flag_template: "--model {model}",
    model_flag_required: true,
    prefix_args: [],
    mid_args: ["--print", "--permission-mode", "bypassPermissions"],
    effort_flag_template: "--effort {effort}",
    prompt_style: "positional",
    usage_reporting: "tokens",
    default_start_template:
      "{binary} --model {model} --print --permission-mode bypassPermissions {prompt_file}",
  },
  codex: {
    id: "codex",
    display_name: "OpenAI Codex CLI",
    model_flag_template: "--model {model}",
    model_flag_required: true,
    prefix_args: ["exec"],
    mid_args: [],
    prompt_style: "positional",
    usage_reporting: "tokens",
    default_start_template: "{binary} exec --model {model} {prompt_file}",
  },
  agy: {
    id: "agy",
    display_name: "Agy",
    // Best-effort: public CLI surface is unstable; bind via config path.
    model_flag_template: "--model {model}",
    model_flag_required: false,
    prefix_args: [],
    mid_args: [],
    prompt_style: "positional",
    usage_reporting: "none",
    default_start_template: "{binary} --model {model} {prompt_file}",
  },
  grok: {
    id: "grok",
    display_name: "Grok CLI",
    model_flag_template: "--model {model}",
    model_flag_required: true,
    prefix_args: [],
    mid_args: [],
    prompt_style: "positional",
    usage_reporting: "tokens",
    default_start_template: "{binary} --model {model} {prompt_file}",
  },
};

export function getCodingProfile(
  id: string,
): CodingAdapterProfile | undefined {
  if (!isFirstClassCodingId(id)) return undefined;
  return CODING_PROFILES[id];
}
