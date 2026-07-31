import { describe, expect, it } from "vitest";
import {
  parseUsageFromText,
  usageFromJsonObject,
} from "./usage.js";

describe("usageFromJsonObject", () => {
  it("reads nested usage tokens", () => {
    expect(
      usageFromJsonObject({
        usage: { input_tokens: 11, output_tokens: 22, total_cost_usd: 0.01 },
      }),
    ).toEqual({
      input_tokens: 11,
      output_tokens: 22,
      estimated_usd: 0.01,
    });
  });

  it("reads camelCase and prompt/completion aliases", () => {
    expect(
      usageFromJsonObject({
        promptTokens: 3,
        completionTokens: 4,
      }),
    ).toEqual({ input_tokens: 3, output_tokens: 4 });
  });

  it("returns null without token fields", () => {
    expect(usageFromJsonObject({ ok: true })).toBeNull();
  });
});

describe("parseUsageFromText", () => {
  it("prefers last JSON line with usage", () => {
    const text = [
      "thinking…",
      JSON.stringify({ usage: { input_tokens: 1, output_tokens: 2 } }),
      "done",
      JSON.stringify({ usage: { input_tokens: 100, output_tokens: 50 } }),
    ].join("\n");
    expect(parseUsageFromText(text)).toEqual({
      input_tokens: 100,
      output_tokens: 50,
    });
  });

  it("parses free-text heuristics", () => {
    const text = "input_tokens: 9\noutput_tokens: 8\ncost: 0.02\n";
    expect(parseUsageFromText(text)).toEqual({
      input_tokens: 9,
      output_tokens: 8,
      estimated_usd: 0.02,
    });
  });

  it("returns null on empty", () => {
    expect(parseUsageFromText("")).toBeNull();
    expect(parseUsageFromText("hello world")).toBeNull();
  });
});
