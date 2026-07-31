/**
 * Example user-adapter registry templates (PR-22).
 *
 * ---------------------------------------------------------------------------
 * Registering a custom CLI with LazyOrch
 * ---------------------------------------------------------------------------
 *
 * First-class adapters (claude, codex, agy, grok, shell) are built in.
 * Anything else — aider, opencode, cursor-agent, custom wrappers — is a
 * **generic** adapter: thin start_template → argv spawn, no usage parse.
 *
 * ## Via CLI
 *
 * ```bash
 * lazyorch adapter register \
 *   --id aider \
 *   --binary aider \
 *   --display-name Aider \
 *   --start-template "{binary} --model {model} --yes-always --message-file {prompt_file}"
 *
 * lazyorch adapter test --id aider
 * lazyorch adapter list --probe
 * ```
 *
 * ## Via `.lazyorch/config.yml`
 *
 * ```yaml
 * adapters:
 *   registry:
 *     - id: aider
 *       display_name: Aider
 *       binary: aider            # PATH name or absolute path
 *       start_template: "{binary} --model {model} --yes-always --message-file {prompt_file}"
 *       version_args: ["--version"]
 *       capabilities:
 *         worktree_ok: true
 *         usage_reporting: none
 *         tier_map:
 *           small: gpt-4o-mini
 *           medium: gpt-4o
 *           large: gpt-4o
 * ```
 *
 * ## start_template placeholders
 *
 * | Placeholder     | Value                                      |
 * |-----------------|--------------------------------------------|
 * | `{binary}`      | Resolved executable                        |
 * | `{model}`       | Concrete model id from router              |
 * | `{prompt_file}` | Absolute path to session `prompt.md`       |
 * | `{cwd}`         | Session working directory (worktree/root)  |
 * | `{session_dir}` | Session directory under runs/…/sessions    |
 * | `{timeout_ms}`  | Session timeout                            |
 * | `{args_prefix}` | Extra argv tokens from `args_prefix`       |
 * | `{agent_id}`    | Agent id when present                      |
 * | `{task_id}`     | Task id when present                       |
 *
 * Templates are tokenized **before** substitution so paths with spaces stay
 * single argv entries (see `templateToArgv` in generic.ts).
 *
 * ## models_args (optional model-list probe)
 *
 * When the CLI can list models non-interactively, set `models_args` so
 * `listModels()` can probe (e.g. opencode: `["models"]`). If omitted or the
 * probe fails, LazyOrch uses `capabilities.models` or unique `tier_map` values.
 *
 * ## Copy a template
 *
 * Use {@link USER_ADAPTER_TEMPLATES} / {@link getUserAdapterTemplate} /
 * {@link userTemplateToRegistryEntry} to seed config programmatically.
 */

import type { AdapterRegistryEntry } from "@lazyorch/shared";
import type { AdapterCapabilities } from "./types.js";
import { codingCapabilities } from "./catalog.js";

/**
 * Example registry template for a user-registered generic CLI.
 * Not auto-loaded into the registry — copy into config or pass to register.
 */
export interface UserAdapterTemplate {
  id: string;
  display_name: string;
  /** Default binary name (PATH) or absolute path hint. */
  binary: string;
  /** PATH discovery candidates (optional). */
  candidates?: string[];
  /**
   * Argv template for GenericCliAdapter.start.
   * Prefer `{binary}` + file-based prompt flags so Windows paths stay intact.
   */
  start_template: string;
  version_args?: string[];
  /** Optional model-list probe argv (e.g. `["models"]`). */
  models_args?: string[];
  args_prefix?: string[];
  capabilities?: Partial<AdapterCapabilities>;
  /** Human notes for operators / docs. */
  notes?: string;
}

/**
 * Built-in example templates: **aider** and **opencode**.
 * These are documentation + convenience seeds — not first-class builtins.
 */
export const USER_ADAPTER_TEMPLATES: Readonly<
  Record<string, UserAdapterTemplate>
> = {
  aider: {
    id: "aider",
    display_name: "Aider",
    binary: "aider",
    candidates: ["aider"],
    version_args: ["--version"],
    // Scripting: one-shot message file, auto-yes, then exit.
    // https://aider.chat/docs/scripting.html
    start_template:
      "{binary} --model {model} --yes-always --message-file {prompt_file}",
    capabilities: codingCapabilities({
      usage_reporting: "none",
      worktree_ok: true,
      streaming: false,
      tier_map: {
        small: "gpt-4o-mini",
        medium: "gpt-4o",
        large: "gpt-4o",
        xlarge: "gpt-4o",
      },
    }),
    notes:
      "Generic template. Aider has no LazyOrch usage parse; install aider on PATH or set binary to an absolute path. Adjust --model ids to match your provider config.",
  },
  opencode: {
    id: "opencode",
    display_name: "OpenCode",
    binary: "opencode",
    candidates: ["opencode"],
    version_args: ["--version"],
    // Non-interactive run; --file attaches the materialized prompt; --auto skips prompts.
    // https://opencode.ai/docs/cli/
    start_template:
      "{binary} run --model {model} --auto --file {prompt_file}",
    // Native model list: `opencode models` → provider/model lines
    models_args: ["models"],
    capabilities: codingCapabilities({
      usage_reporting: "none",
      worktree_ok: true,
      streaming: false,
      tier_map: {
        small: "opencode/gpt-4o-mini",
        medium: "opencode/gpt-4o",
        large: "anthropic/claude-sonnet-4",
        xlarge: "anthropic/claude-opus-4",
      },
    }),
    notes:
      "Generic template. `models_args: [models]` enables listModels probe when the binary is bound. Model ids use provider/model form; tune tier_map to your auth providers.",
  },
} as const;

export type UserAdapterTemplateId = keyof typeof USER_ADAPTER_TEMPLATES;

export function isUserAdapterTemplateId(
  id: string,
): id is UserAdapterTemplateId {
  return Object.prototype.hasOwnProperty.call(USER_ADAPTER_TEMPLATES, id);
}

export function getUserAdapterTemplate(
  id: string,
): UserAdapterTemplate | undefined {
  if (!isUserAdapterTemplateId(id)) return undefined;
  return USER_ADAPTER_TEMPLATES[id];
}

export function listUserAdapterTemplates(): UserAdapterTemplate[] {
  return Object.values(USER_ADAPTER_TEMPLATES).map((t) => ({ ...t }));
}

/**
 * Convert a template into a config `adapters.registry[]` entry shape.
 * Does not discover PATH or write config — caller persists.
 */
export function userTemplateToRegistryEntry(
  template: UserAdapterTemplate,
  overrides: Partial<AdapterRegistryEntry> = {},
): AdapterRegistryEntry {
  const caps = template.capabilities
    ? codingCapabilities(template.capabilities)
    : codingCapabilities({ usage_reporting: "none" });

  const entry: AdapterRegistryEntry = {
    id: template.id,
    display_name: template.display_name,
    binary: template.binary,
    enabled: true,
    source: "user_config",
    start_template: template.start_template,
    version_args: template.version_args ?? ["--version"],
    capabilities: {
      models: caps.models,
      tier_map: { ...caps.tier_map } as Record<string, string>,
      streaming: caps.streaming,
      worktree_ok: caps.worktree_ok,
      usage_reporting: caps.usage_reporting,
      ...(caps.effort_flag !== undefined
        ? { effort_flag: caps.effort_flag }
        : {}),
      ...(caps.max_concurrent_hint !== undefined
        ? { max_concurrent_hint: caps.max_concurrent_hint }
        : {}),
    },
    ...overrides,
  };

  if (template.candidates) {
    entry.candidates = [...template.candidates];
  }
  if (template.args_prefix) {
    entry.args_prefix = [...template.args_prefix];
  }
  if (template.models_args) {
    entry.models_args = [...template.models_args];
  }
  if (overrides.candidates) entry.candidates = overrides.candidates;
  if (overrides.args_prefix) entry.args_prefix = overrides.args_prefix;
  if (overrides.models_args) entry.models_args = overrides.models_args;

  return entry;
}

/** YAML-ish example block for docs / `adapter register` help text. */
export function formatUserTemplateHelp(template: UserAdapterTemplate): string {
  const lines = [
    `# ${template.display_name} (${template.id})`,
    template.notes ? `# ${template.notes}` : undefined,
    `id: ${template.id}`,
    `binary: ${template.binary}`,
    `start_template: "${template.start_template}"`,
    template.models_args
      ? `models_args: [${template.models_args.map((a) => JSON.stringify(a)).join(", ")}]`
      : undefined,
    `version_args: [${(template.version_args ?? ["--version"]).map((a) => JSON.stringify(a)).join(", ")}]`,
  ].filter((l): l is string => l !== undefined);
  return lines.join("\n");
}
