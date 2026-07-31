import { describe, expect, it } from "vitest";
import { scrubJsonForDisplay, scrubText } from "./redact.js";

describe("scrubText (GUI display)", () => {
  it("redacts ghp_ and sk- tokens", () => {
    const t = scrubText(
      "token ghp_abcdefghijklmnopqrstuvwxyz12 and sk-abcdefghijklmnopqrstuv",
    );
    expect(t).not.toMatch(/ghp_/);
    expect(t).not.toMatch(/sk-/);
    expect(t).toContain("[REDACTED]");
  });

  it("redacts AKIA and ASIA AWS key ids", () => {
    const t = scrubText("AKIAIOSFODNN7EXAMPLE ASIAIOSFODNN7EXAMPLE");
    expect(t).not.toContain("AKIA");
    expect(t).not.toContain("ASIA");
    expect(t.match(/\[REDACTED\]/g)?.length).toBe(2);
  });

  it("leaves short sk- under floor intact", () => {
    const input = "sk-not-long-enough";
    expect(scrubText(input)).toBe(input);
  });
});

describe("scrubJsonForDisplay", () => {
  it("redacts secrets inside JSON payloads", () => {
    const out = scrubJsonForDisplay({
      line: "auth ghp_abcdefghijklmnopqrstuvwxyz12",
    });
    expect(out).not.toMatch(/ghp_[A-Za-z0-9_]+/);
    expect(out).toContain("[REDACTED]");
  });
});
