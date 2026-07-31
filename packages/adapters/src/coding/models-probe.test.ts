import { describe, expect, it } from "vitest";
import type { ExecImpl } from "../registry/probe.js";
import type { AdapterRegistration } from "../registry/types.js";
import { codingCapabilities, DEFAULT_TIER_MAPS } from "../registry/catalog.js";
import {
  modelsFromRegistration,
  parseModelListFromText,
  probeModelList,
  resolveModelList,
} from "./models-probe.js";

function baseReg(
  overrides: Partial<AdapterRegistration> = {},
): AdapterRegistration {
  return {
    id: "claude",
    display_name: "Claude",
    binary: "claude",
    binary_path: "/bin/claude",
    enabled: true,
    source: "builtin",
    capabilities: codingCapabilities({
      tier_map: { ...DEFAULT_TIER_MAPS.claude },
    }),
    ...overrides,
  };
}

describe("parseModelListFromText", () => {
  it("parses JSON string array", () => {
    expect(
      parseModelListFromText(
        JSON.stringify(["gpt-4o", "claude-sonnet-4", "o4-mini"]),
      ),
    ).toEqual(["gpt-4o", "claude-sonnet-4", "o4-mini"]);
  });

  it("parses JSON models field with objects", () => {
    expect(
      parseModelListFromText(
        JSON.stringify({
          models: [
            { id: "anthropic/claude-sonnet-4" },
            { name: "openai/gpt-4o" },
          ],
        }),
      ),
    ).toEqual(["anthropic/claude-sonnet-4", "openai/gpt-4o"]);
  });

  it("parses plain provider/model lines (opencode-style)", () => {
    const text = [
      "anthropic/claude-sonnet-4",
      "openai/gpt-4o",
      "Usage: opencode models [provider]",
      "",
      "google/gemini-2.5-pro",
    ].join("\n");
    expect(parseModelListFromText(text)).toEqual([
      "anthropic/claude-sonnet-4",
      "openai/gpt-4o",
      "google/gemini-2.5-pro",
    ]);
  });

  it("strips markdown list markers before tokenizing", () => {
    const text = [
      "- anthropic/claude-sonnet-4",
      "* openai/gpt-4o",
      "• google/gemini-2.5-pro",
    ].join("\n");
    expect(parseModelListFromText(text)).toEqual([
      "anthropic/claude-sonnet-4",
      "openai/gpt-4o",
      "google/gemini-2.5-pro",
    ]);
  });

  it("returns empty for noise", () => {
    expect(parseModelListFromText("error: not found\n")).toEqual([]);
  });
});

describe("modelsFromRegistration", () => {
  it("prefers capabilities.models", () => {
    const reg = baseReg({
      capabilities: codingCapabilities({
        models: ["a", "b"],
        tier_map: { small: "x" },
      }),
    });
    expect(modelsFromRegistration(reg)).toEqual(["a", "b"]);
  });

  it("returns empty when models unset (does not invent tier_map)", () => {
    const reg = baseReg({
      capabilities: codingCapabilities({
        models: [],
        tier_map: {
          small: "claude-haiku-4-5",
          medium: "claude-sonnet-4-6",
          large: "claude-sonnet-4-6",
        },
      }),
    });
    expect(modelsFromRegistration(reg)).toEqual([]);
  });
});

describe("probeModelList / resolveModelList", () => {
  it("probes with injected exec", async () => {
    const exec: ExecImpl = async (_bin, args) => {
      expect(args).toEqual(["models"]);
      return {
        code: 0,
        stdout: "anthropic/claude-sonnet-4\nopenai/gpt-4o\n",
        stderr: "",
      };
    };
    const reg = baseReg({ models_args: ["models"] });
    const models = await probeModelList(reg, ["models"], { exec });
    expect(models).toEqual(["anthropic/claude-sonnet-4", "openai/gpt-4o"]);
  });

  it("resolve prefers configured models over probe", async () => {
    let called = false;
    const exec: ExecImpl = async () => {
      called = true;
      return { code: 0, stdout: "probed-model\n", stderr: "" };
    };
    const reg = baseReg({
      capabilities: codingCapabilities({ models: ["configured"] }),
      models_args: ["models"],
    });
    const models = await resolveModelList(reg, ["models"], { exec });
    expect(models).toEqual(["configured"]);
    expect(called).toBe(false);
  });

  it("resolve probes when models empty", async () => {
    const exec: ExecImpl = async () => ({
      code: 0,
      stdout: "probed-a\nprobed-b\n",
      stderr: "",
    });
    const reg = baseReg({
      capabilities: codingCapabilities({
        models: [],
        tier_map: { small: "tier-only" },
      }),
      models_args: ["models"],
    });
    const models = await resolveModelList(reg, ["models"], { exec });
    expect(models).toEqual(["probed-a", "probed-b"]);
  });

  it("resolve falls back to tier_map when models_args set but probe skipped", async () => {
    const reg = baseReg({
      capabilities: codingCapabilities({
        models: [],
        tier_map: { small: "s", medium: "m" },
      }),
    });
    const models = await resolveModelList(reg, ["models"], {
      skip_probe: true,
    });
    expect(models).toEqual(["s", "m"]);
  });

  it("resolve returns [] when models empty and no models_args", async () => {
    const reg = baseReg({
      capabilities: codingCapabilities({
        models: [],
        tier_map: { small: "s", medium: "m" },
      }),
    });
    const models = await resolveModelList(reg, undefined, { skip_probe: true });
    expect(models).toEqual([]);
  });

  it("probe returns [] when unbound", async () => {
    const exec: ExecImpl = async () => {
      throw new Error("should not run");
    };
    const reg = baseReg({ unbound: true, binary_path: undefined });
    expect(await probeModelList(reg, ["models"], { exec })).toEqual([]);
  });
});
