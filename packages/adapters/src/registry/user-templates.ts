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
 * # Seed from a built-in example template (binary/start_template/models_args):
 * lazyorch adapter register --from-template aider
 * lazyorch adapter register --from-template opencode
 *
 * # Or hand-roll:
 * lazyorch adapter register \
 *   --id aider \
 *   --binary aider \
 *   --name Aider \
 *   --start-template "{binary} --model {model} --yes-always --message-file {prompt_file}" \
 *   --models-args "[]"
 *
 * # OpenCode uses positional message text via {prompt} (file contents):
 * lazyorch adapter register \
 *   --id opencode \
 *   --binary opencode \
 *   --start-template "{binary} run --model {model} --auto {prompt}" \
 *   --models-args models
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
 * | `{prompt}`      | **Contents** of prompt.md (whole argv)     |
 * | `{cwd}`         | Session working directory (worktree/root)  |
 * | `{session_dir}` | Session directory under runs/…/sessions    |
 * | `{timeout_ms}`  | Session timeout                            |
 * | `{args_prefix}` | Extra argv tokens from `args_prefix`       |
 * | `{agent_id}`    | Agent id when present                      |
 * | `{task_id}`     | Task id when present                       |
 *
 * Prefer `{prompt_file}` when the CLI has a message-file flag (aider).
 * Prefer whole-token `{prompt}` when the CLI takes the user message as a
 * **positional** argv (opencode `run [message..]`). Do **not** use `--file`
 * for OpenCode as the message — `--file` only attaches files to a message.
 *
 * Templates are tokenized **before** substitution so paths (and multi-line
 * `{prompt}`) stay single argv entries (see `templateToArgv` in generic.ts).
 *
 * ## models_args (optional model-list probe)
 *
 * When the CLI can list models non-interactively, set `models_args` so
 * `listModels()` can probe (e.g. opencode: `["models"]`). Configured
 * `capabilities.models` always wins. When models_args is set but the probe
 * is empty, unique `tier_map` values are soft routing examples only — not an
 * allowlist. With neither models nor models_args, listModels returns [].
 *
 * ## Copy a template
 *
 * Use {@link USER_ADAPTER_TEMPLATES} / {@link getUserAdapterTemplate} /
 * {@link userTemplateToRegistryEntry} / CLI `--from-template` to seed config.
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
   * Prefer `{prompt_file}` for path flags; whole-token `{prompt}` for
   * positional message CLIs (content loaded at start).
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

function freezeTemplate(t: UserAdapterTemplate): UserAdapterTemplate {
  if (t.capabilities) {
    Object.freeze(t.capabilities);
    if (t.capabilities.tier_map) Object.freeze(t.capabilities.tier_map);
    if (t.capabilities.models) Object.freeze(t.capabilities.models);
  }
  if (t.candidates) Object.freeze(t.candidates);
  if (t.models_args) Object.freeze(t.models_args);
  if (t.args_prefix) Object.freeze(t.args_prefix);
  return Object.freeze(t);
}

/**
 * Built-in example templates: **aider** and **opencode**.
 * These are documentation + convenience seeds — not first-class builtins.
 * Nested objects are frozen; getters return clones.
 */
export const USER_ADAPTER_TEMPLATES: Readonly<
  Record<string, UserAdapterTemplate>
> = Object.freeze({
  aider: freezeTemplate({
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
  }),
  opencode: freezeTemplate({
    id: "opencode",
    display_name: "OpenCode",
    binary: "opencode",
    candidates: ["opencode"],
    version_args: ["--version"],
    // Non-interactive: `opencode run [message..]` — message is positional.
    // {prompt} expands to prompt.md **contents** as a single argv entry.
    // Do NOT use --file for the message; --file only attaches extra files.
    // https://opencode.ai/docs/cli/
    start_template: "{binary} run --model {model} --auto {prompt}",
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
      "Generic template. Message is positional via {prompt} (file contents). models_args: [models] enables listModels probe. Model ids use provider/model form; tune tier_map to your auth providers.",
  }),
});

export type UserAdapterTemplateId = keyof typeof USER_ADAPTER_TEMPLATES;

function cloneTemplate(t: UserAdapterTemplate): UserAdapterTemplate {
  return {
    id: t.id,
    display_name: t.display_name,
    binary: t.binary,
    start_template: t.start_template,
    ...(t.candidates ? { candidates: [...t.candidates] } : {}),
    ...(t.version_args ? { version_args: [...t.version_args] } : {}),
    ...(t.models_args ? { models_args: [...t.models_args] } : {}),
    ...(t.args_prefix ? { args_prefix: [...t.args_prefix] } : {}),
    ...(t.notes ? { notes: t.notes } : {}),
    ...(t.capabilities
      ? {
          capabilities: {
            ...t.capabilities,
            ...(t.capabilities.models
              ? { models: [...t.capabilities.models] }
              : {}),
            ...(t.capabilities.tier_map
              ? { tier_map: { ...t.capabilities.tier_map } }
              : {}),
          },
        }
      : {}),
  };
}

export function isUserAdapterTemplateId(
  id: string,
): id is UserAdapterTemplateId {
  return Object.prototype.hasOwnProperty.call(USER_ADAPTER_TEMPLATES, id);
}

/** Clone of a built-in template (safe to mutate). */
export function getUserAdapterTemplate(
  id: string,
): UserAdapterTemplate | undefined {
  if (!isUserAdapterTemplateId(id)) return undefined;
  const t = USER_ADAPTER_TEMPLATES[id];
  if (!t) return undefined;
  return cloneTemplate(t);
}

/** Clones of all built-in templates. */
export function listUserAdapterTemplates(): UserAdapterTemplate[] {
  return Object.values(USER_ADAPTER_TEMPLATES).map(cloneTemplate);
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
