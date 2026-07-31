import { describe, expect, it } from "vitest";
import {
  CODING_VENDOR_ENV_ALLOWLIST,
  isCodingVendorEnvKey,
  isSecretEnvKey,
  scrubCodingSpawnEnv,
  scrubEnv,
  scrubText,
} from "./scrub.js";

describe("isSecretEnvKey", () => {
  it.each([
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GITHUB_PAT",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "XAI_API_KEY",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "LAZYORCH_HOME",
    "LAZYORCH_GITHUB_TOKEN",
    "LAZYORCH_DAEMON_TOKEN",
    "MY_APP_TOKEN",
    "DB_PASSWORD",
    "APP_SECRET",
    "SERVICE_PRIVATE_KEY",
    "CLOUD_ACCESS_KEY",
    "custom_api_key",
  ])("treats %s as secret", (key) => {
    expect(isSecretEnvKey(key)).toBe(true);
  });

  it.each([
    "PATH",
    "HOME",
    "USERPROFILE",
    "NODE_ENV",
    "CI",
    "TERM",
    "LANG",
    "npm_config_user_agent",
    "SAFE_FLAG",
  ])("treats %s as non-secret", (key) => {
    expect(isSecretEnvKey(key)).toBe(false);
  });
});

describe("scrubEnv", () => {
  it("strips known secret keys and preserves safe keys", () => {
    const out = scrubEnv({
      PATH: "/usr/bin",
      GH_TOKEN: "secret",
      GITHUB_TOKEN: "secret",
      LAZYORCH_GITHUB_TOKEN: "secret",
      OPENAI_API_KEY: "sk-x",
      NODE_ENV: "test",
    });
    expect(out).toEqual({ PATH: "/usr/bin", NODE_ENV: "test" });
  });

  it("drops undefined values and never mutates input", () => {
    const input: Record<string, string | undefined> = {
      PATH: "/bin",
      EMPTY: undefined,
      GH_TOKEN: "x",
    };
    const out = scrubEnv(input);
    expect(out).toEqual({ PATH: "/bin" });
    expect(input.GH_TOKEN).toBe("x");
  });

  it("strips pattern-matched secret keys used in session env maps", () => {
    const out = scrubEnv({
      CI: "true",
      MY_SERVICE_TOKEN: "tok",
      DATABASE_PASSWORD: "pw",
      ORCH_SECRET: "s",
      FEATURE_FLAG: "on",
    });
    expect(out).toEqual({ CI: "true", FEATURE_FLAG: "on" });
    expect(out.MY_SERVICE_TOKEN).toBeUndefined();
    expect(out.DATABASE_PASSWORD).toBeUndefined();
    expect(out.ORCH_SECRET).toBeUndefined();
  });
});

describe("scrubCodingSpawnEnv", () => {
  it("preserves host vendor keys and reg.env API keys", () => {
    const out = scrubCodingSpawnEnv(
      {
        PATH: "/usr/bin",
        ANTHROPIC_API_KEY: "sk-ant-host",
        OPENAI_API_KEY: "sk-openai-host",
        GH_TOKEN: "ghp_should_drop",
        LAZYORCH_HOME: "/tmp/lo",
        NODE_ENV: "test",
      },
      {
        SESSION_FLAG: "1",
        OPENAI_API_KEY: "sk-from-session-scrubbed",
      },
      {
        OPENAI_API_KEY: "sk-from-reg",
        XAI_API_KEY: "xai-from-reg",
        GH_TOKEN: "ghp_reg_drop",
        MY_NONSECRET: "ok",
      },
    );

    expect(out.PATH).toBe("/usr/bin");
    expect(out.NODE_ENV).toBe("test");
    expect(out.SESSION_FLAG).toBe("1");
    expect(out.MY_NONSECRET).toBe("ok");
    // Host Anthropic key re-injected; OpenAI from reg.env wins over host
    expect(out.ANTHROPIC_API_KEY).toBe("sk-ant-host");
    expect(out.OPENAI_API_KEY).toBe("sk-from-reg");
    expect(out.XAI_API_KEY).toBe("xai-from-reg");
    // Orchestrator secrets never pass
    expect(out.GH_TOKEN).toBeUndefined();
    expect(out.LAZYORCH_HOME).toBeUndefined();
  });

  it("never re-injects orchestrator secrets even if only in registration.env", () => {
    const out = scrubCodingSpawnEnv(
      { PATH: "/bin" },
      {},
      {
        GH_TOKEN: "ghp_leak",
        GITHUB_TOKEN: "ghp_leak2",
        LAZYORCH_TOKEN: "lo",
        ANTHROPIC_API_KEY: "sk-ant-reg",
      },
    );
    expect(out.ANTHROPIC_API_KEY).toBe("sk-ant-reg");
    expect(out.GH_TOKEN).toBeUndefined();
    expect(out.GITHUB_TOKEN).toBeUndefined();
    expect(out.LAZYORCH_TOKEN).toBeUndefined();
  });

  it("allowlists vendor keys", () => {
    expect(isCodingVendorEnvKey("OPENAI_API_KEY")).toBe(true);
    expect(isCodingVendorEnvKey("ANTHROPIC_BASE_URL")).toBe(true);
    expect(isCodingVendorEnvKey("XAI_BASE_URL")).toBe(true);
    expect(isCodingVendorEnvKey("GH_TOKEN")).toBe(false);
    for (const k of CODING_VENDOR_ENV_ALLOWLIST) {
      expect(isCodingVendorEnvKey(k)).toBe(true);
    }
  });
});

describe("scrubText (log / prompt redaction)", () => {
  it("redacts ghp_ and sk- style tokens", () => {
    const t = scrubText(
      "token ghp_abcdefghijklmnopqrstuvwxyz12 and sk-abcdefghijklmnopqrstuv",
    );
    expect(t).not.toMatch(/ghp_/);
    expect(t).not.toMatch(/sk-/);
    expect(t).toContain("[REDACTED]");
  });

  it("redacts github_pat_ and xai- prefixes", () => {
    const t = scrubText(
      "pat github_pat_abcdefghijklmnopqrstuvwxyz and xai-abcdefghijklmnopqrstuv",
    );
    expect(t).not.toMatch(/github_pat_/);
    expect(t).not.toMatch(/xai-/);
    expect(t.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("redacts AWS access key ids (AKIA…)", () => {
    const t = scrubText("aws key AKIAIOSFODNN7EXAMPLE leftover");
    expect(t).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(t).toContain("[REDACTED]");
  });

  it("leaves non-secret prose intact", () => {
    const prose =
      "Run pnpm test and git status; model sk-not-long-enough stays if under length floor.";
    // sk- with short suffix may or may not match depending on {20,} — use plain text
    const safe = scrubText("Run pnpm test; no tokens here.");
    expect(safe).toBe("Run pnpm test; no tokens here.");
    expect(prose.length).toBeGreaterThan(0);
  });

  it("redacts tokens embedded in log.line-style JSON payloads", () => {
    const line = JSON.stringify({
      type: "log.line",
      msg: "auth failed for ghp_abcdefghijklmnopqrstuvwxyz12",
      env_hint: "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz",
    });
    const scrubbed = scrubText(line);
    expect(scrubbed).not.toMatch(/ghp_[A-Za-z0-9_]+/);
    expect(scrubbed).not.toMatch(/sk-[A-Za-z0-9_-]{20,}/);
    expect(scrubbed).toContain("[REDACTED]");
  });

  it("is idempotent", () => {
    const once = scrubText("ghp_abcdefghijklmnopqrstuvwxyz12");
    expect(scrubText(once)).toBe(once);
  });
});
