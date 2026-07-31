/**
 * Best-effort usage parse from coding-agent stdio (PR-09 thin → PR-22 deeper).
 *
 * Prefer structured JSON / JSONL (Claude result events, OpenAI-style usage
 * objects) over free text. Not vendor-perfect — budgets still fall back to
 * hours when tokens/USD are missing.
 *
 * Recognized shapes (non-exhaustive):
 * - `{ usage: { input_tokens, output_tokens, total_cost_usd } }`
 * - Claude JSONL `{ type: "result", usage, total_cost_usd }`
 * - Claude `{ message: { usage } }` stream wrappers
 * - OpenAI aliases: prompt_tokens / completion_tokens (snake + camel)
 * - Cache tokens (cache_read_input_tokens, …) folded into input_tokens
 * - Nested `cost: { total_cost_usd }` / dollar free-text
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

/** Merge two Usage values; `next` fields win when defined. */
export function mergeUsage(prev: Usage | null, next: Usage | null): Usage | null {
  if (!prev) return next ? { ...next } : null;
  if (!next) return { ...prev };
  const out: Usage = { ...prev };
  if (next.input_tokens !== undefined) out.input_tokens = next.input_tokens;
  if (next.output_tokens !== undefined) out.output_tokens = next.output_tokens;
  if (next.estimated_usd !== undefined) out.estimated_usd = next.estimated_usd;
  return out;
}

/**
 * Prefer a richer Usage when comparing two candidates (more fields / cost).
 * Used when scanning JSONL so a final `type:result` beats a thin mid-stream blob.
 */
export function preferRicherUsage(
  a: Usage | null,
  b: Usage | null,
): Usage | null {
  if (!a) return b;
  if (!b) return a;
  const score = (u: Usage): number => {
    let s = 0;
    if (u.input_tokens !== undefined) s += 2;
    if (u.output_tokens !== undefined) s += 2;
    if (u.estimated_usd !== undefined) s += 3;
    return s;
  };
  // Equal score → prefer `b` (later in stream).
  return score(b) >= score(a) ? b : a;
}

/**
 * Extract Usage from a loose JSON object (usage nested or flat token keys).
 */
export function usageFromJsonObject(obj: unknown): Usage | null {
  if (!isRecord(obj)) return null;

  // Nested usage / token_usage / tokens (OpenAI, Claude, Codex-ish)
  for (const key of ["usage", "token_usage", "tokens", "tokenUsage"]) {
    if (isRecord(obj[key])) {
      const nested = usageFromFlat(obj[key] as Record<string, unknown>);
      if (nested) {
        // Top-level cost on Claude result events often sits beside usage.
        const topCost = costFromRecord(obj);
        if (topCost !== undefined && nested.estimated_usd === undefined) {
          nested.estimated_usd = topCost;
        }
        return nested;
      }
    }
  }

  // Claude stream / assistant wrapper: message.usage
  if (isRecord(obj.message)) {
    const fromMessage = usageFromJsonObject(obj.message);
    if (fromMessage) {
      const topCost = costFromRecord(obj);
      if (topCost !== undefined && fromMessage.estimated_usd === undefined) {
        fromMessage.estimated_usd = topCost;
      }
      return fromMessage;
    }
  }

  // result.usage (Claude-style JSONL wrapper / nested result)
  if (isRecord(obj.result)) {
    const fromResult = usageFromJsonObject(obj.result);
    if (fromResult) return fromResult;
  }

  // data.usage (some SDKs)
  if (isRecord(obj.data)) {
    const fromData = usageFromJsonObject(obj.data);
    if (fromData) return fromData;
  }

  return usageFromFlat(obj);
}

function costFromRecord(obj: Record<string, unknown>): number | undefined {
  const direct =
    num(obj.estimated_usd) ??
    num(obj.total_cost_usd) ??
    num(obj.total_cost) ??
    num(obj.cost_usd) ??
    num(obj.cost);
  if (direct !== undefined) return direct;

  if (isRecord(obj.cost)) {
    return (
      num(obj.cost.estimated_usd) ??
      num(obj.cost.total_cost_usd) ??
      num(obj.cost.total_cost) ??
      num(obj.cost.cost_usd) ??
      num(obj.cost.amount) ??
      num(obj.cost.usd)
    );
  }
  if (isRecord(obj.pricing)) {
    return (
      num(obj.pricing.estimated_usd) ??
      num(obj.pricing.total_cost_usd) ??
      num(obj.pricing.total)
    );
  }
  return undefined;
}

function usageFromFlat(obj: Record<string, unknown>): Usage | null {
  const baseInput =
    num(obj.input_tokens) ??
    num(obj.inputTokens) ??
    num(obj.prompt_tokens) ??
    num(obj.promptTokens) ??
    num(obj.input);

  const cacheRead =
    num(obj.cache_read_input_tokens) ??
    num(obj.cacheReadInputTokens) ??
    num(obj.cache_read_tokens) ??
    num(obj.cacheReadTokens);

  const cacheCreate =
    num(obj.cache_creation_input_tokens) ??
    num(obj.cacheCreationInputTokens) ??
    num(obj.cache_write_input_tokens) ??
    num(obj.cacheWriteInputTokens) ??
    num(obj.cache_creation_tokens);

  // Fold cache tokens into billable input when present (Claude-style).
  let input = baseInput;
  const cacheExtra = (cacheRead ?? 0) + (cacheCreate ?? 0);
  if (cacheExtra > 0) {
    input = (baseInput ?? 0) + cacheExtra;
  }

  const output =
    num(obj.output_tokens) ??
    num(obj.outputTokens) ??
    num(obj.completion_tokens) ??
    num(obj.completionTokens) ??
    num(obj.output);

  const cost = costFromRecord(obj);

  if (input === undefined && output === undefined && cost === undefined) {
    return null;
  }

  const usage: Usage = {};
  if (input !== undefined) usage.input_tokens = input;
  if (output !== undefined) usage.output_tokens = output;
  if (cost !== undefined) usage.estimated_usd = cost;
  return usage;
}

/** True when a JSON object looks like a terminal Claude/Codex result event. */
function isTerminalResultEvent(obj: Record<string, unknown>): boolean {
  const t = obj.type;
  if (t === "result" || t === "completion" || t === "done") return true;
  if (obj.subtype === "success" || obj.subtype === "error") return true;
  return false;
}

/**
 * Try to parse a whole line or an embedded JSON object substring.
 */
function tryParseJsonCandidates(text: string): unknown[] {
  const out: unknown[] = [];
  const trimmed = text.trim();
  if (!trimmed) return out;

  // Whole text
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      out.push(JSON.parse(trimmed) as unknown);
      return out;
    } catch {
      // fall through to embedded extract
    }
  }

  // Embedded object: first `{` … last `}` (best-effort for log prefixes)
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      out.push(JSON.parse(trimmed.slice(start, end + 1)) as unknown);
    } catch {
      // ignore
    }
  }
  return out;
}

/**
 * Scan text (stdio capture) for the best parseable usage blob.
 * Checks each non-empty line as JSON (and embedded JSON), then whole text.
 * Prefers richer / later matches; terminal `type:result` events score higher.
 */
export function parseUsageFromText(text: string): Usage | null {
  if (!text || text.trim().length === 0) return null;

  const lines = text.split(/\r?\n/);
  let best: Usage | null = null;
  let bestIsTerminal = false;

  const consider = (parsed: unknown, terminal: boolean): void => {
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        const u = usageFromJsonObject(item);
        if (!u) continue;
        if (terminal && !bestIsTerminal) {
          best = u;
          bestIsTerminal = true;
        } else if (terminal === bestIsTerminal) {
          best = preferRicherUsage(best, u);
        } else if (!bestIsTerminal) {
          best = preferRicherUsage(best, u);
        }
        // if best is terminal and this is not, keep best unless richer+terminal already handled
      }
      return;
    }
    const u = usageFromJsonObject(parsed);
    if (!u) return;
    if (terminal && !bestIsTerminal) {
      best = u;
      bestIsTerminal = true;
      return;
    }
    if (!terminal && bestIsTerminal) {
      // Keep terminal result unless this is somehow also terminal (handled above).
      return;
    }
    best = preferRicherUsage(best, u);
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!trimmed.includes("{") && !trimmed.startsWith("[")) continue;

    for (const parsed of tryParseJsonCandidates(trimmed)) {
      const terminal =
        isRecord(parsed) && isTerminalResultEvent(parsed);
      consider(parsed, terminal);
    }
  }

  if (best) return best;

  // Whole-file JSON
  try {
    const parsed: unknown = JSON.parse(text.trim());
    const u = usageFromJsonObject(parsed);
    if (u) return u;
  } catch {
    // fall through to regex heuristics
  }

  return parseUsageFromFreeText(text);
}

/**
 * Free-text heuristics (last matches win). Covers common CLI summary lines.
 */
export function parseUsageFromFreeText(text: string): Usage | null {
  const usage: Usage = {};

  // input_tokens: N / prompt tokens: N / Input tokens: N
  const inputMatch = text.match(
    /(?:input[_ ]?tokens?|prompt[_ ]?tokens?)\s*[:=]\s*(\d+)/gi,
  );
  // Also "Tokens: in=N" / "in: N tokens"
  const inputAlt = text.match(
    /(?:\bin\s*[:=]\s*(\d+)|(\d+)\s+input(?:\s+tokens?)?)/gi,
  );
  // "X input / Y output" combined line
  const paired = [
    ...text.matchAll(
      /(\d+)\s*(?:input|prompt)\s*(?:tokens?)?\s*[/|,]\s*(\d+)\s*(?:output|completion)\s*(?:tokens?)?/gi,
    ),
  ];

  if (paired.length > 0) {
    const last = paired[paired.length - 1];
    if (last?.[1]) usage.input_tokens = Number(last[1]);
    if (last?.[2]) usage.output_tokens = Number(last[2]);
  } else {
    if (inputMatch && inputMatch.length > 0) {
      const m = inputMatch[inputMatch.length - 1]?.match(/(\d+)\s*$/);
      if (m?.[1]) usage.input_tokens = Number(m[1]);
    } else if (inputAlt && inputAlt.length > 0) {
      const last = inputAlt[inputAlt.length - 1] ?? "";
      const m = last.match(/(\d+)/);
      if (m?.[1]) usage.input_tokens = Number(m[1]);
    }

    const outputMatch = text.match(
      /(?:output[_ ]?tokens?|completion[_ ]?tokens?)\s*[:=]\s*(\d+)/gi,
    );
    const outputAlt = text.match(
      /(?:\bout\s*[:=]\s*(\d+)|(\d+)\s+output(?:\s+tokens?)?)/gi,
    );
    if (outputMatch && outputMatch.length > 0) {
      const m = outputMatch[outputMatch.length - 1]?.match(/(\d+)\s*$/);
      if (m?.[1]) usage.output_tokens = Number(m[1]);
    } else if (outputAlt && outputAlt.length > 0) {
      const last = outputAlt[outputAlt.length - 1] ?? "";
      const m = last.match(/(\d+)/);
      if (m?.[1]) usage.output_tokens = Number(m[1]);
    }
  }

  const costMatch = text.match(
    /(?:estimated_usd|total_cost_usd|cost_usd|total_cost|cost)\s*[:=]\s*\$?\s*([\d.]+)/gi,
  );
  const costDollar = text.match(/\$\s*([\d]+\.[\d]+)/g);
  if (costMatch && costMatch.length > 0) {
    const m = costMatch[costMatch.length - 1]?.match(/([\d.]+)\s*$/);
    if (m?.[1]) {
      const c = Number(m[1]);
      if (Number.isFinite(c)) usage.estimated_usd = c;
    }
  } else if (costDollar && costDollar.length > 0) {
    // Only accept $N.NN near cost-ish context later; take last dollar amount
    // when the word "cost" appears nearby in the full text.
    if (/\bcost\b/i.test(text)) {
      const m = costDollar[costDollar.length - 1]?.match(/([\d.]+)/);
      if (m?.[1]) {
        const c = Number(m[1]);
        if (Number.isFinite(c)) usage.estimated_usd = c;
      }
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
