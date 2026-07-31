/**
 * Build argv for first-class coding adapters from vendor profile + session.
 */

import { join } from "node:path";
import type { AgentSession } from "../types.js";
import type { AdapterRegistration } from "../registry/types.js";
import {
  templateToArgv,
  type TemplateVars,
} from "../registry/generic.js";
import type { CodingAdapterProfile } from "./profiles.js";

export class CodingArgvError extends Error {
  readonly code: "missing_model";

  constructor(code: CodingArgvError["code"], message: string) {
    super(message);
    this.name = "CodingArgvError";
    this.code = code;
  }
}

/**
 * Expand a simple template like `--model {model}` into argv tokens.
 * Values with spaces stay single tokens (placeholder-only expand).
 */
export function expandFlagTemplate(
  template: string,
  vars: Record<string, string>,
): string[] {
  if (!template.trim()) return [];
  const tokens = template.trim().split(/\s+/);
  return tokens.map((tok) => {
    let out = tok;
    for (const [key, val] of Object.entries(vars)) {
      const ph = `{${key}}`;
      if (out === ph) return val;
      if (out.includes(ph)) out = out.split(ph).join(val);
    }
    return out;
  });
}

export interface BuildCodingArgvOptions {
  profile: CodingAdapterProfile;
  registration: AdapterRegistration;
  session: AgentSession;
  /**
   * When true, force the start_template path even if the template matches
   * the profile default. Default is false (use programmatic profile argv).
   * Custom templates (≠ profile.default_start_template) always use the
   * template path regardless of this flag.
   */
  prefer_template?: boolean;
}

/**
 * Resolve binary path for spawn (absolute when known).
 */
export function resolveCodingBinary(reg: AdapterRegistration): string {
  return reg.binary_path ?? reg.binary;
}

/** True when model is usable for a required model flag. */
export function isUsableModelId(model: string): boolean {
  const m = model.trim();
  return m.length > 0 && m !== "n/a";
}

/**
 * Build full argv for a coding adapter start.
 *
 * Order (profile path):
 *   [binary] [args_prefix?] [prefix_args] [model flags?] [effort?] [mid_args] [prompt]
 *
 * If registration has a custom start_template (≠ profile default), use
 * template path so user overrides stay authoritative.
 *
 * Throws {@link CodingArgvError} (`missing_model`) when the profile requires
 * a model flag and session.model is empty or `"n/a"`.
 */
export function buildCodingArgv(options: BuildCodingArgvOptions): string[] {
  const { profile, registration, session } = options;
  const binary = resolveCodingBinary(registration);
  const prompt_file =
    session.prompt_file ??
    (session.session_dir
      ? join(session.session_dir, "prompt.md")
      : "prompt.md");

  const model = session.model?.trim() ?? "";

  // Required model flag: refuse empty / "n/a" (best-effort agy may omit).
  if (profile.model_flag_required && !isUsableModelId(model)) {
    throw new CodingArgvError(
      "missing_model",
      `adapter ${profile.id} requires a model id (got ${JSON.stringify(session.model ?? "")})`,
    );
  }

  const customTemplate =
    registration.start_template &&
    registration.start_template !== profile.default_start_template;

  if (customTemplate || options.prefer_template === true) {
    const template =
      registration.start_template ?? profile.default_start_template;
    const vars: TemplateVars = {
      cwd: session.cwd,
      model: session.model,
      prompt_file,
      session_dir: session.session_dir ?? "",
      timeout_ms: session.timeout_ms,
      binary,
      agent_id: session.agent_id,
      // Coding custom templates typically use {prompt_file}; leave {prompt} empty
      // unless callers populate it (generic adapter reads the file at start).
      prompt: "",
    };
    if (registration.args_prefix) vars.args_prefix = registration.args_prefix;
    if (session.task_id !== undefined) vars.task_id = session.task_id;

    let argv = templateToArgv(template, vars);
    if (
      !template.includes("{binary}") &&
      argv[0] !== binary
    ) {
      argv = [binary, ...(registration.args_prefix ?? []), ...argv];
    }
    return argv;
  }

  // Programmatic profile argv (first-class default path).
  const argv: string[] = [binary];

  if (registration.args_prefix) {
    for (const a of registration.args_prefix) {
      if (a.length > 0) argv.push(a);
    }
  }

  for (const a of profile.prefix_args) {
    argv.push(a);
  }

  // Required: always include (validated above).
  // Best-effort (agy): skip empty / "n/a".
  const includeModel =
    profile.model_flag_template.length > 0 && isUsableModelId(model);

  if (includeModel) {
    const modelArgs = expandFlagTemplate(profile.model_flag_template, {
      model,
    });
    argv.push(...modelArgs);
  }

  // Effort when profile supports it and registration advertises effort_flag
  if (
    session.effort &&
    profile.effort_flag_template &&
    registration.capabilities.effort_flag === true
  ) {
    const effortArgs = expandFlagTemplate(profile.effort_flag_template, {
      effort: session.effort,
    });
    argv.push(...effortArgs);
  }

  for (const a of profile.mid_args) {
    argv.push(a);
  }

  // positional prompt
  argv.push(prompt_file);

  return argv;
}
