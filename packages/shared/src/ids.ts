import { randomBytes } from "node:crypto";

/** ID prefixes used across LazyOrch entities (design: run_, tsk_, agt_, …). */
export const ID_PREFIXES = ["run", "tsk", "agt", "gate", "iss", "plan"] as const;

export type IdPrefix = (typeof ID_PREFIXES)[number];

/** Full id format: `{prefix}_{24 lowercase hex chars}` (12 random bytes). */
const ID_SUFFIX_RE = /^[0-9a-f]{24}$/;

const PREFIX_SET = new Set<string>(ID_PREFIXES);

/**
 * Generate a unique entity id with the given prefix.
 * Format: `{prefix}_{24 hex chars}` (12 random bytes).
 */
export function generateId(prefix: IdPrefix): string {
  const suffix = randomBytes(12).toString("hex");
  return `${prefix}_${suffix}`;
}

/**
 * True if `id` matches `{prefix}_{24 hex}` for a known (or specified) prefix.
 */
export function isPrefixedId(id: string, prefix?: IdPrefix): boolean {
  return parseIdPrefix(id) !== null && (prefix === undefined || id.startsWith(`${prefix}_`));
}

/**
 * Parse prefix from a strictly formatted id (`{prefix}_{24 hex}`), or null if invalid.
 */
export function parseIdPrefix(id: string): IdPrefix | null {
  const underscore = id.indexOf("_");
  if (underscore <= 0) return null;
  const p = id.slice(0, underscore);
  const suffix = id.slice(underscore + 1);
  if (!PREFIX_SET.has(p) || !ID_SUFFIX_RE.test(suffix)) return null;
  return p as IdPrefix;
}
