/**
 * Thin / best-effort usage parse from coding-agent stdio (PR-09).
 * Not vendor-perfect; prefers structured JSON over free text.
 */

import { readFile } from "node:fs/promises";
import type { Usage } from "../types.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return undefined;
}

/**
 * Extract Usage from a loose JSON object (usage nested or flat token keys).
 */
export function usageFromJsonObject(obj: unknown): Usage | null {
  if (!isRecord(obj)) return null;

  // Nested usage / token_usage / tokens
  for (const key of ["usage", "token_usage", "tokens", "tokenUsage"]) {
    if (isRecord(obj[key])) {
      const nested = usageFromFlat(obj[key] as Record<string, unknown>);
      if (nested) return nested;
    }
  }

  // result.usage (Claude-style JSONL wrapper)
  if (isRecord(obj.result)) {
    const fromResult = usageFromJsonObject(obj.result);
    if (fromResult) return fromResult;
  }

  return usageFromFlat(obj);
}

function usageFromFlat(obj: Record<string, unknown>): Usage | null {
  const input =
    num(obj.input_tokens) ??
    num(obj.inputTokens) ??
    num(obj.prompt_tokens) ??
    num(obj.promptTokens);
  const output =
    num(obj.output_tokens) ??
    num(obj.outputTokens) ??
    num(obj.completion_tokens) ??
    num(obj.completionTokens);
  const cost =
    num(obj.estimated_usd) ??
    num(obj.total_cost_usd) ??
    num(obj.total_cost) ??
    num(obj.cost_usd) ??
    num(obj.cost);

  if (input === undefined && output === undefined && cost === undefined) {
    return null;
  }

  const usage: Usage = {};
  if (input !== undefined) usage.input_tokens = input;
  if (output !== undefined) usage.output_tokens = output;
  if (cost !== undefined) usage.estimated_usd = cost;
  return usage;
}

/**
 * Scan text (stdio capture) for the last parseable usage blob.
 * Checks each non-empty line as JSON, then whole text as JSON.
 */
export function parseUsageFromText(text: string): Usage | null {
  if (!text || text.trim().length === 0) return null;

  const lines = text.split(/\r?\n/);
  let last: Usage | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const u = usageFromJsonObject(item);
          if (u) last = u;
        }
      } else {
        const u = usageFromJsonObject(parsed);
        if (u) last = u;
      }
    } catch {
      // not JSON line
    }
  }

  if (last) return last;

  // Whole-file JSON
  try {
    const parsed: unknown = JSON.parse(text.trim());
    return usageFromJsonObject(parsed);
  } catch {
    // fall through to regex heuristics
  }

  // Free-text heuristics (last matches win)
  const inputMatch = text.match(
    /(?:input[_ ]?tokens?|prompt[_ ]?tokens?)\s*[:=]\s*(\d+)/gi,
  );
  const outputMatch = text.match(
    /(?:output[_ ]?tokens?|completion[_ ]?tokens?)\s*[:=]\s*(\d+)/gi,
  );
  const costMatch = text.match(
    /(?:estimated_usd|total_cost_usd|cost_usd|cost)\s*[:=]\s*\$?([\d.]+)/gi,
  );

  const usage: Usage = {};
  if (inputMatch && inputMatch.length > 0) {
    const m = inputMatch[inputMatch.length - 1]?.match(/(\d+)\s*$/);
    if (m?.[1]) usage.input_tokens = Number(m[1]);
  }
  if (outputMatch && outputMatch.length > 0) {
    const m = outputMatch[outputMatch.length - 1]?.match(/(\d+)\s*$/);
    if (m?.[1]) usage.output_tokens = Number(m[1]);
  }
  if (costMatch && costMatch.length > 0) {
    const m = costMatch[costMatch.length - 1]?.match(/([\d.]+)\s*$/);
    if (m?.[1]) {
      const c = Number(m[1]);
      if (Number.isFinite(c)) usage.estimated_usd = c;
    }
  }

  if (
    usage.input_tokens === undefined &&
    usage.output_tokens === undefined &&
    usage.estimated_usd === undefined
  ) {
    return null;
  }
  return usage;
}

/** Best-effort read of session stdio.log for usage. */
export async function parseUsageFromLog(
  logPath: string,
): Promise<Usage | null> {
  try {
    const text = await readFile(logPath, "utf8");
    return parseUsageFromText(text);
  } catch {
    return null;
  }
}
