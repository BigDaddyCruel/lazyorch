/**
 * Adapter registry types (design-lazyorch KD-37/39).
 * Resolved registration differs from config AdapterRegistryEntry:
 * binary is always set (PATH name or absolute), source reflects how it was bound.
 */

import type { AdapterSource, ModelTier } from "@lazyorch/shared";
import type { AdapterId, DoctorResult } from "../types.js";

export type UsageReporting = "none" | "tokens" | "tokens_and_cost";

export interface AdapterCapabilities {
  models: string[];
  tier_map: Partial<Record<ModelTier, string>>;
  streaming: boolean;
  worktree_ok: boolean;
  usage_reporting: UsageReporting;
  effort_flag?: boolean;
  max_concurrent_hint?: number;
}

/**
 * Resolved adapter registration — what the registry exposes after
 * builtin catalog + PATH discovery + user config merge.
 */
export interface AdapterRegistration {
  id: AdapterId;
  display_name: string;
  /** Resolved executable: absolute path, PATH name, or "shell" sentinel. */
  binary: string;
  args_prefix?: string[];
  version_args?: string[];
  version_floor?: string;
  /**
   * Optional argv for model-list probe (PR-22), e.g. `["models"]`.
   * When set, listModels may exec the binary; see coding/models-probe.ts.
   */
  models_args?: string[];
  enabled: boolean;
  /** How the entry was found. v1 enum only (KD-39). */
  source: AdapterSource;
  capabilities: AdapterCapabilities;
  env?: Record<string, string>;
  /**
   * Generic/shell: command template for start.
   * Placeholders: {cwd} {model} {prompt_file} {session_dir} {timeout_ms}
   *   {binary} {args_prefix} {agent_id} {task_id}
   *
   * Registering custom CLIs: copy an entry from USER_ADAPTER_TEMPLATES
   * (aider, opencode) or set start_template via `lazyorch adapter register`.
   * See registry/user-templates.ts for full placeholder docs.
   */
  start_template?: string;
  /** Candidate binary names used during discovery (not always on final reg). */
  candidates?: string[];
  /**
   * True when a first-class coding id has no bound binary (agy/grok typical).
   * Shell never unbound.
   */
  unbound?: boolean;
  /** Absolute path when PATH discovery / user binary resolved to a real file. */
  binary_path?: string;
}

/** Builtin catalog row before path resolution. */
export interface BuiltinCatalogEntry {
  id: AdapterId;
  display_name: string;
  /** Default PATH candidate names (discovery order). */
  candidates: string[];
  /** shell is deterministic; others are LLM coding agents. */
  kind: "llm" | "deterministic";
  version_args: string[];
  version_floor?: string;
  /** Optional model-list probe argv (PR-22). */
  models_args?: string[];
  capabilities: AdapterCapabilities;
  /** Optional default start_template for thin generic invoke (PR-09 deepens). */
  start_template?: string;
  args_prefix?: string[];
}

export type AdapterHealthStatus =
  | "ok"
  | "disabled"
  | "unbound"
  | "error";

/** One row of the capability / health matrix. */
export interface AdapterHealthRow {
  id: AdapterId;
  display_name: string;
  enabled: boolean;
  source: AdapterSource;
  status: AdapterHealthStatus;
  binary?: string;
  binary_path?: string;
  version?: string;
  unbound?: boolean;
  message: string;
  capabilities: AdapterCapabilities;
  /** Thin capability matrix flags (MVP: start/cancel/doctor required; rest thin). */
  matrix: CapabilityMatrixFlags;
}

export interface CapabilityMatrixFlags {
  doctor: boolean;
  start: boolean;
  cancel: boolean;
  model_flag: boolean | "n/a" | "template" | "best-effort";
  usage_parse: boolean | "best-effort" | "none";
  worktree_cwd: boolean;
}

export interface HealthMatrix {
  adapters: AdapterHealthRow[];
  /** At least one non-shell coding adapter is healthy (enabled + binary). */
  has_healthy_coding_adapter: boolean;
  /** Count of enabled adapters (any kind). */
  enabled_count: number;
  healthy_count: number;
}

export type { AdapterId, DoctorResult, AdapterSource };
