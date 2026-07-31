/**
 * Scrub secrets from env maps and prompt text before materialization.
 * Secrets (GH_TOKEN, GITHUB_TOKEN, LAZYORCH_*, redaction-regex keys)
 * are never written into prompt.md or default session env.
 *
 * Coding CLI child processes use {@link scrubCodingSpawnEnv}: orchestrator
 * secrets stay scrubbed, but well-known vendor API keys are preserved so
 * live claude/codex/grok can authenticate.
 */

/** Env key names that must never be forwarded into agent sessions / prompts. */
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

/**
 * Vendor credentials allowed on coding-CLI child processes only.
 * Never written into prompt.md; still scrubbed from session materialization
 * via {@link scrubEnv}.
 */
export const CODING_VENDOR_ENV_ALLOWLIST = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT_ID",
  "OPENAI_API_BASE",
  "XAI_API_KEY",
  "XAI_BASE_URL",
]);

export function isSecretEnvKey(key: string): boolean {
  if (SECRET_ENV_EXACT.has(key)) return true;
  if (SECRET_ENV_RE.test(key)) return true;
  return false;
}

/** True for well-known coding-CLI vendor auth / endpoint env keys. */
export function isCodingVendorEnvKey(key: string): boolean {
  return CODING_VENDOR_ENV_ALLOWLIST.has(key);
}

/**
 * Return a new env map without secret keys.
 * Values of non-secret keys are left intact.
 * Use for prompt materialization and shell/generic adapters.
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

/**
 * Env policy for first-class coding CLI spawns (claude/codex/agy/grok):
 * 1. Scrub process + session env (drops GH_TOKEN, LAZYORCH_*, API keys, …)
 * 2. Re-inject allowlisted vendor keys from process env (host auth)
 * 3. Merge registration.env: allowlist vendor keys + non-secret keys
 *
 * Orchestrator secrets (GH_TOKEN, LAZYORCH_*) never pass through, even if
 * present in registration.env.
 */
export function scrubCodingSpawnEnv(
  processEnv: Record<string, string | undefined>,
  sessionEnv: Record<string, string | undefined> = {},
  registrationEnv?: Record<string, string>,
): Record<string, string> {
  const out = scrubEnv({ ...processEnv, ...sessionEnv });

  for (const key of CODING_VENDOR_ENV_ALLOWLIST) {
    const v = processEnv[key];
    if (typeof v === "string" && v.length > 0) {
      out[key] = v;
    }
  }

  if (registrationEnv) {
    for (const [k, v] of Object.entries(registrationEnv)) {
      if (isCodingVendorEnvKey(k)) {
        out[k] = v;
        continue;
      }
      // Non-secret config (e.g. feature flags) OK; block GH_TOKEN / LAZYORCH_*.
      if (!isSecretEnvKey(k)) {
        out[k] = v;
      }
    }
  }

  return out;
}

/** Redact secret-looking substrings in prompt / log text. */
export function scrubText(text: string): string {
  return text.replace(SECRET_VALUE_RE, "[REDACTED]");
}
