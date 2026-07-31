/**
 * Scrub secrets from env maps and prompt text before materialization.
 * Secrets (GH_TOKEN, GITHUB_TOKEN, LAZYORCH_*, redaction-regex keys)
 * are never written into prompt.md or default session env.
 */

/** Env key names that must never be forwarded into agent sessions. */
const SECRET_ENV_EXACT = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITHUB_PAT",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "XAI_API_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
]);

/** Match keys like LAZYORCH_*, *_TOKEN, *_SECRET, *_API_KEY, *_PASSWORD. */
const SECRET_ENV_RE =
  /^(LAZYORCH_.*|.*_(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|ACCESS_KEY))$/i;

/** Best-effort redaction of secret-looking tokens in free text. */
const SECRET_VALUE_RE =
  /\b(ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xai-[A-Za-z0-9_-]{20,})\b/g;

export function isSecretEnvKey(key: string): boolean {
  if (SECRET_ENV_EXACT.has(key)) return true;
  if (SECRET_ENV_RE.test(key)) return true;
  return false;
}

/**
 * Return a new env map without secret keys.
 * Values of non-secret keys are left intact.
 */
export function scrubEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (isSecretEnvKey(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Redact secret-looking substrings in prompt / log text. */
export function scrubText(text: string): string {
  return text.replace(SECRET_VALUE_RE, "[REDACTED]");
}
