import { describe, expect, it } from "vitest";
import {
  mergeUsage,
  parseUsageFromFreeText,
  parseUsageFromText,
  preferRicherUsage,
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

  it("folds Claude cache tokens into input_tokens", () => {
    expect(
      usageFromJsonObject({
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 50,
          output_tokens: 5,
        },
      }),
    ).toEqual({
      input_tokens: 160,
      output_tokens: 5,
    });
  });

  it("reads Claude result top-level total_cost_usd beside usage", () => {
    expect(
      usageFromJsonObject({
        type: "result",
        subtype: "success",
        total_cost_usd: 0.042,
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
    ).toEqual({
      input_tokens: 1,
      output_tokens: 2,
      estimated_usd: 0.042,
    });
  });

  it("reads message.usage stream wrappers", () => {
    expect(
      usageFromJsonObject({
        type: "assistant",
        message: {
          usage: { input_tokens: 7, output_tokens: 8 },
        },
      }),
    ).toEqual({ input_tokens: 7, output_tokens: 8 });
  });

  it("reads nested cost object", () => {
    expect(
      usageFromJsonObject({
        usage: { prompt_tokens: 1, completion_tokens: 2 },
        cost: { total_cost_usd: 0.5 },
      }),
    ).toEqual({
      input_tokens: 1,
      output_tokens: 2,
      estimated_usd: 0.5,
    });
  });

  it("returns null without token fields", () => {
    expect(usageFromJsonObject({ ok: true })).toBeNull();
  });
});

describe("mergeUsage / preferRicherUsage", () => {
  it("merges with next winning", () => {
    expect(
      mergeUsage(
        { input_tokens: 1, output_tokens: 2 },
        { output_tokens: 9, estimated_usd: 0.1 },
      ),
    ).toEqual({
      input_tokens: 1,
      output_tokens: 9,
      estimated_usd: 0.1,
    });
  });

  it("prefers usage that includes cost", () => {
    const thin = { input_tokens: 100, output_tokens: 50 };
    const rich = { input_tokens: 10, output_tokens: 5, estimated_usd: 0.01 };
    expect(preferRicherUsage(thin, rich)).toEqual(rich);
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

  it("prefers Claude type=result over intermediate assistant usage", () => {
    const text = [
      JSON.stringify({
        type: "assistant",
        message: { usage: { input_tokens: 999, output_tokens: 999 } },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        total_cost_usd: 0.02,
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 40,
          output_tokens: 3,
        },
      }),
    ].join("\n");
    expect(parseUsageFromText(text)).toEqual({
      input_tokens: 50,
      output_tokens: 3,
      estimated_usd: 0.02,
    });
  });

  it("merges terminal cost-only result with prior token totals", () => {
    const text = [
      JSON.stringify({
        type: "assistant",
        message: { usage: { input_tokens: 100, output_tokens: 50 } },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        total_cost_usd: 0.03,
      }),
    ].join("\n");
    expect(parseUsageFromText(text)).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      estimated_usd: 0.03,
    });
  });

  it("does not treat subtype-only objects as terminal", () => {
    const text = [
      JSON.stringify({
        subtype: "success",
        total_cost_usd: 0.99,
      }),
      JSON.stringify({
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
    ].join("\n");
    // subtype alone must not lock out later usage
    expect(parseUsageFromText(text)).toEqual({
      input_tokens: 1,
      output_tokens: 2,
      estimated_usd: 0.99,
    });
  });

  it("does not double-count non-Claude cache_read_tokens aliases", () => {
    expect(
      usageFromJsonObject({
        usage: {
          input_tokens: 100,
          cache_read_tokens: 50,
          output_tokens: 1,
        },
      }),
    ).toEqual({ input_tokens: 100, output_tokens: 1 });
  });

  it("parses embedded JSON after a log prefix", () => {
    const text = `INFO session done ${JSON.stringify({
      usage: { input_tokens: 4, output_tokens: 5, cost_usd: 0.001 },
    })}\n`;
    expect(parseUsageFromText(text)).toEqual({
      input_tokens: 4,
      output_tokens: 5,
      estimated_usd: 0.001,
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

  it("parses paired free-text input/output line", () => {
    expect(parseUsageFromFreeText("Used 12 input / 34 output tokens")).toEqual(
      {
        input_tokens: 12,
        output_tokens: 34,
      },
    );
  });

  it("parses dollar cost near cost keyword", () => {
    expect(parseUsageFromFreeText("total cost was $1.25 for this run")).toEqual(
      {
        estimated_usd: 1.25,
      },
    );
  });

  it("ignores unrelated in: N and remote $ amounts", () => {
    expect(parseUsageFromFreeText("retry in: 3 seconds")).toBeNull();
    expect(
      parseUsageFromFreeText("price is $9.99 but no usage reported"),
    ).toBeNull();
  });

  it("returns null on empty", () => {
    expect(parseUsageFromText("")).toBeNull();
    expect(parseUsageFromText("hello world")).toBeNull();
  });
});
