/**
 * Model-list probes for coding / generic adapters (PR-22).
 *
 * Many CLIs expose a models subcommand (e.g. `opencode models`); others do not.
 * When `models_args` is set on a registration/profile, we exec the binary and
 * parse stdout. Otherwise listModels falls back to capabilities.models, then
 * unique tier_map values.
 *
 * Injectable exec — same contract as version probe — so unit tests need no
 * real CLI.
 */

import {
  defaultExecImpl,
  type ExecImpl,
  type ExecResult,
} from "../registry/probe.js";
import type { AdapterRegistration } from "../registry/types.js";

export interface ModelListProbeOptions {
  exec?: ExecImpl;
  /** Max time for model list probe (default 8s). */
  timeout_ms?: number;
}

const MODEL_ID_RE =
  /^[A-Za-z0-9][A-Za-z0-9_./:@+-]{1,120}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function uniquePreserveOrder(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    const t = id.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function looksLikeModelId(s: string): boolean {
  const t = s.trim();
  if (!t || t.length > 120) return false;
  // Reject help/usage noise
  if (/^(usage|options|flags|commands|help|error|warning)\b/i.test(t)) {
    return false;
  }
  if (/\s/.test(t)) return false;
  return MODEL_ID_RE.test(t);
}

/**
 * Pull model ids from a JSON value (array of strings, or objects with id/name).
 */
export function modelsFromJsonValue(value: unknown): string[] {
  if (typeof value === "string" && looksLikeModelId(value)) {
    return [value.trim()];
  }
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const item of value) {
      if (typeof item === "string" && looksLikeModelId(item)) {
        out.push(item.trim());
        continue;
      }
      if (isRecord(item)) {
        const id =
          (typeof item.id === "string" && item.id) ||
          (typeof item.model === "string" && item.model) ||
          (typeof item.name === "string" && item.name) ||
          (typeof item.model_id === "string" && item.model_id) ||
          "";
        if (id && looksLikeModelId(id)) out.push(id.trim());
      }
    }
    return uniquePreserveOrder(out);
  }
  if (isRecord(value)) {
    for (const key of ["models", "data", "result", "items"]) {
      if (value[key] !== undefined) {
        const nested = modelsFromJsonValue(value[key]);
        if (nested.length > 0) return nested;
      }
    }
    // Map of id → meta
    const keys = Object.keys(value).filter(looksLikeModelId);
    if (keys.length > 0 && keys.length === Object.keys(value).length) {
      return uniquePreserveOrder(keys);
    }
  }
  return [];
}

/**
 * Parse model identifiers from CLI stdout/stderr.
 * Supports JSON arrays/objects and plain line lists (e.g. `provider/model`).
 */
export function parseModelListFromText(text: string): string[] {
  if (!text || text.trim().length === 0) return [];

  const trimmed = text.trim();

  // Whole-buffer JSON
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const fromJson = modelsFromJsonValue(parsed);
      if (fromJson.length > 0) return fromJson;
    } catch {
      // fall through
    }
  }

  const fromLines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw) continue;

    // JSON line
    if (raw.startsWith("{") || raw.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(raw);
        const ids = modelsFromJsonValue(parsed);
        for (const id of ids) fromLines.push(id);
        continue;
      } catch {
        // not JSON
      }
    }

    // Tab/column: take first token if it looks like a model id
    // e.g. "anthropic/claude-sonnet-4  context=200k"
    const first = raw.split(/\s+/)[0] ?? "";
    // Strip common list bullets
    const cleaned = first.replace(/^[-*•]\s*/, "");
    if (looksLikeModelId(cleaned)) {
      fromLines.push(cleaned);
    }
  }

  return uniquePreserveOrder(fromLines);
}

/**
 * Fallbacks when probe is unavailable: capabilities.models, then tier_map values.
 */
export function modelsFromRegistration(
  reg: AdapterRegistration,
): string[] {
  if (reg.capabilities.models.length > 0) {
    return [...reg.capabilities.models];
  }
  const fromTier = Object.values(reg.capabilities.tier_map).filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  return uniquePreserveOrder(fromTier);
}

/**
 * Probe an adapter binary for model ids using `models_args`.
 * Returns [] when unbound, missing args, or parse yields nothing.
 */
export async function probeModelList(
  reg: AdapterRegistration,
  modelsArgs: readonly string[] | undefined,
  options: ModelListProbeOptions = {},
): Promise<string[]> {
  if (!modelsArgs || modelsArgs.length === 0) return [];
  if (reg.unbound || !reg.binary || reg.binary === "" || reg.binary === "shell") {
    return [];
  }
  if (!reg.enabled) return [];

  const exec = options.exec ?? defaultExecImpl;
  const timeout_ms = options.timeout_ms ?? 8_000;
  const binary = reg.binary_path ?? reg.binary;

  let result: ExecResult;
  try {
    result = await exec(binary, [...modelsArgs], { timeout_ms });
  } catch {
    return [];
  }

  // Accept non-zero exit if stdout still lists models (some CLIs are noisy).
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return parseModelListFromText(text);
}

/**
 * Resolve listModels for an adapter registration.
 * Order: configured capabilities.models → live probe → tier_map values.
 */
export async function resolveModelList(
  reg: AdapterRegistration,
  modelsArgs: readonly string[] | undefined,
  options: ModelListProbeOptions & { skip_probe?: boolean } = {},
): Promise<string[]> {
  if (reg.capabilities.models.length > 0) {
    return [...reg.capabilities.models];
  }
  if (!options.skip_probe) {
    const probed = await probeModelList(reg, modelsArgs, options);
    if (probed.length > 0) return probed;
  }
  return modelsFromRegistration(reg);
}
