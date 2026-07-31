import { describe, expect, it } from "vitest";
import { isSecretEnvKey, scrubEnv, scrubText } from "./scrub.js";

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

describe("scrubText", () => {
  it("redacts ghp_ and sk- style tokens", () => {
    const t = scrubText("token ghp_abcdefghijklmnopqrstuvwxyz12 and sk-abcdefghijklmnopqrstuv");
    expect(t).not.toMatch(/ghp_/);
    expect(t).not.toMatch(/sk-/);
    expect(t).toContain("[REDACTED]");
  });
});
