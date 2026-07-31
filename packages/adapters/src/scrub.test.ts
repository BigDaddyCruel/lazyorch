import { describe, expect, it } from "vitest";
import {
  isCodingVendorEnvKey,
  isSecretEnvKey,
  scrubCodingSpawnEnv,
  scrubEnv,
  scrubText,
} from "./scrub.js";

describe("scrubEnv", () => {
  it("strips known secret keys", () => {
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

  it("strips *_TOKEN / *_SECRET patterns", () => {
    expect(isSecretEnvKey("MY_APP_TOKEN")).toBe(true);
    expect(isSecretEnvKey("DB_PASSWORD")).toBe(true);
    expect(isSecretEnvKey("HOME")).toBe(false);
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

  it("allowlists vendor keys", () => {
    expect(isCodingVendorEnvKey("OPENAI_API_KEY")).toBe(true);
    expect(isCodingVendorEnvKey("GH_TOKEN")).toBe(false);
  });
});

describe("scrubText", () => {
  it("redacts ghp_ and sk- style tokens", () => {
    const t = scrubText("token ghp_abcdefghijklmnopqrstuvwxyz12 and sk-abcdefghijklmnopqrstuv");
    expect(t).not.toMatch(/ghp_/);
    expect(t).not.toMatch(/sk-/);
    expect(t).toContain("[REDACTED]");
  });
});
