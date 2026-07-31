import { randomBytes } from "node:crypto";

/** ID prefixes used across LazyOrch entities (design: run_, tsk_, agt_, …). */
export const ID_PREFIXES = ["run", "tsk", "agt", "gate", "iss", "plan"] as const;

export type IdPrefix = (typeof ID_PREFIXES)[number];

const PREFIX_SET = new Set<string>(ID_PREFIXES);

/**
 * Generate a unique entity id with the given prefix.
 * Format: `{prefix}_{24 hex chars}` (12 random bytes).
 */
export function generateId(prefix: IdPrefix): string {
  const suffix = randomBytes(12).toString("hex");
  return `${prefix}_${suffix}`;
}

/** True if `id` starts with a known LazyOrch prefix and has a non-empty suffix. */
export function isPrefixedId(id: string, prefix?: IdPrefix): boolean {
  if (prefix !== undefined) {
    return id.startsWith(`${prefix}_`) && id.length > prefix.length + 1;
  }
  const underscore = id.indexOf("_");
  if (underscore <= 0) return false;
  const p = id.slice(0, underscore);
  return PREFIX_SET.has(p) && id.length > underscore + 1;
}

/** Parse prefix from an id, or null if invalid. */
export function parseIdPrefix(id: string): IdPrefix | null {
  const underscore = id.indexOf("_");
  if (underscore <= 0) return null;
  const p = id.slice(0, underscore);
  if (!PREFIX_SET.has(p) || id.length <= underscore + 1) return null;
  return p as IdPrefix;
}
