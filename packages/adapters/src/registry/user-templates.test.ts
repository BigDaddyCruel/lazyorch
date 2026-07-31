import { describe, expect, it } from "vitest";
import { AdapterRegistryEntrySchema } from "@lazyorch/shared";
import { createGenericAdapter, templateToArgv } from "./generic.js";
import type { ExecImpl } from "./probe.js";
import {
  formatUserTemplateHelp,
  getUserAdapterTemplate,
  listUserAdapterTemplates,
  USER_ADAPTER_TEMPLATES,
  userTemplateToRegistryEntry,
} from "./user-templates.js";
import { codingCapabilities } from "./catalog.js";
import type { AdapterRegistration } from "./types.js";

describe("USER_ADAPTER_TEMPLATES", () => {
  it("includes aider and opencode examples", () => {
    expect(Object.keys(USER_ADAPTER_TEMPLATES).sort()).toEqual([
      "aider",
      "opencode",
    ]);
    expect(getUserAdapterTemplate("aider")?.binary).toBe("aider");
    expect(getUserAdapterTemplate("opencode")?.models_args).toEqual([
      "models",
    ]);
    expect(listUserAdapterTemplates()).toHaveLength(2);
  });

  it("start templates use path-safe / message-safe placeholders", () => {
    const aider = USER_ADAPTER_TEMPLATES.aider;
    expect(aider.start_template).toContain("{binary}");
    expect(aider.start_template).toContain("{model}");
    expect(aider.start_template).toContain("{prompt_file}");
    expect(aider.start_template).toContain("--message-file");

    const oc = USER_ADAPTER_TEMPLATES.opencode;
    // OpenCode run takes positional message; {prompt} = file contents.
    expect(oc.start_template).toContain("run");
    expect(oc.start_template).toContain("{prompt}");
    expect(oc.start_template).not.toContain("--file");
    expect(oc.start_template).not.toContain("{prompt_file}");
  });

  it("get/list return clones (mutating does not touch singleton)", () => {
    const a = getUserAdapterTemplate("aider");
    expect(a).toBeDefined();
    if (a?.capabilities?.tier_map) {
      a.capabilities.tier_map.small = "mutated";
    }
    const again = getUserAdapterTemplate("aider");
    expect(again?.capabilities?.tier_map?.small).toBe("gpt-4o-mini");
  });

  it("opencode templateToArgv puts message body as positional {prompt}", () => {
    const t = USER_ADAPTER_TEMPLATES.opencode;
    const body = "Implement the feature.\nLine two.";
    const argv = templateToArgv(t.start_template, {
      cwd: "/proj",
      model: "anthropic/claude-sonnet-4",
      prompt_file: "/proj/prompt.md",
      prompt: body,
      session_dir: "/proj/sess",
      timeout_ms: 60_000,
      binary: "opencode",
    });
    expect(argv).toEqual([
      "opencode",
      "run",
      "--model",
      "anthropic/claude-sonnet-4",
      "--auto",
      body,
    ]);
  });

  it("userTemplateToRegistryEntry is schema-valid", () => {
    for (const t of listUserAdapterTemplates()) {
      const entry = userTemplateToRegistryEntry(t);
      const parsed = AdapterRegistryEntrySchema.parse(entry);
      expect(parsed.id).toBe(t.id);
      expect(parsed.start_template).toBe(t.start_template);
      if (t.id === "opencode") {
        expect(parsed.models_args).toEqual(["models"]);
      }
    }
  });

  it("templateToArgv expands aider template without splitting paths", () => {
    const t = USER_ADAPTER_TEMPLATES.aider;
    const argv = templateToArgv(t.start_template, {
      cwd: "C:\\Work\\My Project",
      model: "gpt-4o",
      prompt_file: "C:\\Work\\My Project\\.lazyorch\\sessions\\s1\\prompt.md",
      session_dir: "C:\\Work\\My Project\\.lazyorch\\sessions\\s1",
      timeout_ms: 60_000,
      binary: "C:\\Tools\\aider.exe",
    });
    expect(argv[0]).toBe("C:\\Tools\\aider.exe");
    expect(argv).toContain("--model");
    expect(argv).toContain("gpt-4o");
    expect(argv).toContain("--message-file");
    expect(argv).toContain(
      "C:\\Work\\My Project\\.lazyorch\\sessions\\s1\\prompt.md",
    );
  });

  it("generic listModels probes opencode models_args", async () => {
    const entry = userTemplateToRegistryEntry(USER_ADAPTER_TEMPLATES.opencode);
    const reg: AdapterRegistration = {
      id: entry.id,
      display_name: entry.display_name ?? entry.id,
      binary: "opencode",
      binary_path: "/bin/opencode",
      enabled: true,
      source: "user_config",
      start_template: entry.start_template,
      models_args: entry.models_args,
      capabilities: codingCapabilities({
        models: [],
        tier_map: { small: "fallback-small" },
        usage_reporting: "none",
      }),
    };
    const exec: ExecImpl = async (_b, args) => {
      expect(args).toEqual(["models"]);
      return {
        code: 0,
        stdout: "anthropic/claude-sonnet-4\nopenai/gpt-4o\n",
        stderr: "",
      };
    };
    const adapter = createGenericAdapter(reg, { execImpl: exec });
    await expect(adapter.listModels()).resolves.toEqual([
      "anthropic/claude-sonnet-4",
      "openai/gpt-4o",
    ]);
  });

  it("formatUserTemplateHelp includes id and template", () => {
    const help = formatUserTemplateHelp(USER_ADAPTER_TEMPLATES.aider);
    expect(help).toMatch(/id: aider/);
    expect(help).toMatch(/start_template:/);
  });
});
