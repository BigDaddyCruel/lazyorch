/**
 * Best-effort display redaction for operator-facing GUI log surfaces.
 * Keep aligned with `packages/adapters/src/scrub.ts` `SECRET_VALUE_RE` /
 * `scrubText` (private-beta; not a substitute for KD-45 integrate scan).
 *
 * GUI intentionally does not depend on `@lazyorch/adapters` (browser bundle).
 */

const SECRET_VALUE_RE =
  /\b(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xai-[A-Za-z0-9_-]{20,}|(?:AKIA|ASIA)[0-9A-Z]{16})\b/g;

/** Redact secret-looking substrings in free text for display only. */
export function scrubText(text: string): string {
  return text.replace(SECRET_VALUE_RE, "[REDACTED]");
}

/** JSON.stringify for display with best-effort secret redaction. */
export function scrubJsonForDisplay(value: unknown): string {
  try {
    return scrubText(JSON.stringify(value));
  } catch {
    return scrubText(String(value));
  }
}
