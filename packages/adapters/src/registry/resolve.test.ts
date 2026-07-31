import { describe, expect, it } from "vitest";
import { AdaptersConfigSchema } from "@lazyorch/shared";
import { resolveAdapterRegistrations } from "./resolve.js";
import { BUILTIN_ADAPTER_IDS } from "./catalog.js";

function config(overrides: Record<string, unknown> = {}) {
  return AdaptersConfigSchema.parse(overrides);
}

describe("resolveAdapterRegistrations", () => {
  it("includes all builtins with shell always bound", async () => {
    const regs = await resolveAdapterRegistrations(config({}), {
      discover: false,
    });
    const ids = regs.map((r) => r.id);
    for (const id of BUILTIN_ADAPTER_IDS) {
      expect(ids).toContain(id);
    }
    const shell = regs.find((r) => r.id === "shell");
    expect(shell?.unbound).toBeUndefined();
    expect(shell?.binary).toBe("shell");
    expect(shell?.source).toBe("builtin");
  });

  it("PATH discovery binds matching candidates", async () => {
    const regs = await resolveAdapterRegistrations(config({}), {
      platform: "linux",
      env: { PATH: "/opt/bin" },
      exists: async (p) =>
        p === "/opt/bin/claude" || p === "/opt/bin/codex",
    });
    const claude = regs.find((r) => r.id === "claude");
    expect(claude?.unbound).toBeUndefined();
    expect(claude?.binary_path).toBe("/opt/bin/claude");
    expect(claude?.source).toBe("path_discover");

    const agy = regs.find((r) => r.id === "agy");
    expect(agy?.unbound).toBe(true);
  });

  it("user binary override is authoritative", async () => {
    const regs = await resolveAdapterRegistrations(
      config({
        agy: { enabled: true, binary: "C:\\Tools\\agy.exe", candidates: ["agy"] },
      }),
      {
        platform: "win32",
        env: { PATH: "C:\\Windows", PATHEXT: ".EXE" },
        exists: async (p) => p === "C:\\Tools\\agy.exe",
      },
    );
    const agy = regs.find((r) => r.id === "agy");
    expect(agy?.source).toBe("user_config");
    expect(agy?.binary_path).toBe("C:\\Tools\\agy.exe");
    expect(agy?.unbound).toBeUndefined();
  });

  it("merges user registry entries", async () => {
    const regs = await resolveAdapterRegistrations(
      config({
        registry: [
          {
            id: "aider",
            binary: "/usr/local/bin/aider",
            start_template: "{binary} --model {model} {prompt_file}",
            capabilities: {
              tier_map: { small: "gpt-4o-mini", large: "gpt-4o" },
            },
          },
        ],
      }),
      {
        platform: "linux",
        env: { PATH: "/usr/local/bin" },
        exists: async (p) => p === "/usr/local/bin/aider",
      },
    );
    const aider = regs.find((r) => r.id === "aider");
    expect(aider).toBeDefined();
    expect(aider?.source).toBe("user_config");
    expect(aider?.binary_path).toBe("/usr/local/bin/aider");
    expect(aider?.capabilities.tier_map.small).toBe("gpt-4o-mini");
    expect(aider?.start_template).toContain("{binary}");
  });

  it("user registry can re-bind builtin id", async () => {
    const regs = await resolveAdapterRegistrations(
      config({
        registry: [
          {
            id: "grok",
            binary: "/custom/grok",
            display_name: "Custom Grok",
          },
        ],
      }),
      {
        platform: "linux",
        env: { PATH: "/custom" },
        exists: async (p) => p === "/custom/grok",
      },
    );
    const groks = regs.filter((r) => r.id === "grok");
    expect(groks).toHaveLength(1);
    expect(groks[0]?.display_name).toBe("Custom Grok");
    expect(groks[0]?.binary_path).toBe("/custom/grok");
    expect(groks[0]?.source).toBe("user_config");
  });

  it("respects disabled builtins", async () => {
    const regs = await resolveAdapterRegistrations(
      config({ claude: { enabled: false, binary: null } }),
      { discover: false },
    );
    expect(regs.find((r) => r.id === "claude")?.enabled).toBe(false);
  });

  it("applies adapters.models tier_map override", async () => {
    const regs = await resolveAdapterRegistrations(
      config({
        models: {
          claude: { small: "my-small", large: "my-large" },
        },
      }),
      { discover: false },
    );
    const claude = regs.find((r) => r.id === "claude");
    expect(claude?.capabilities.tier_map.small).toBe("my-small");
    expect(claude?.capabilities.tier_map.large).toBe("my-large");
  });

  it("grok tries multiple candidates", async () => {
    const tried: string[] = [];
    const regs = await resolveAdapterRegistrations(config({}), {
      platform: "linux",
      env: { PATH: "/bin" },
      exists: async (p) => {
        tried.push(p);
        return p === "/bin/xai";
      },
    });
    const grok = regs.find((r) => r.id === "grok");
    expect(grok?.binary_path).toBe("/bin/xai");
    expect(tried).toContain("/bin/grok");
    expect(tried).toContain("/bin/grok-cli");
    expect(tried).toContain("/bin/xai");
  });
});
