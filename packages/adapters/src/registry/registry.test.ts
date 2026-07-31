import { describe, expect, it } from "vitest";
import { AdaptersConfigSchema } from "@lazyorch/shared";
import { AdapterRegistry } from "./registry.js";
import type { SpawnImpl } from "../shell/adapter.js";
import type { ExecImpl } from "./probe.js";
import { splitTemplateArgv } from "./generic.js";
import { codingCapabilities } from "./catalog.js";
import type { AdapterRegistration } from "./types.js";

function config(overrides: Record<string, unknown> = {}) {
  return AdaptersConfigSchema.parse(overrides);
}

describe("AdapterRegistry", () => {
  it("lists builtins and builds health matrix with fakes", async () => {
    const exec: ExecImpl = async (binary) => ({
      code: 0,
      stdout: `${binary} 1.0.0`,
      stderr: "",
    });
    const registry = await AdapterRegistry.fromConfig(config({}), {
      platform: "linux",
      env: { PATH: "/bin" },
      exists: async (p) => p === "/bin/claude" || p === "/bin/codex",
      execImpl: exec,
    });

    const list = registry.list();
    expect(list.length).toBeGreaterThanOrEqual(5);
    expect(registry.get("shell")?.binary).toBe("shell");
    expect(registry.get("claude")?.binary_path).toBe("/bin/claude");
    expect(registry.get("agy")?.unbound).toBe(true);

    const matrix = await registry.healthMatrix();
    expect(matrix.has_healthy_coding_adapter).toBe(true);
    expect(matrix.adapters.find((a) => a.id === "shell")?.status).toBe("ok");
    expect(matrix.adapters.find((a) => a.id === "claude")?.status).toBe("ok");
    expect(matrix.adapters.find((a) => a.id === "agy")?.status).toBe(
      "unbound",
    );
    // Capability matrix fields present
    const claudeRow = matrix.adapters.find((a) => a.id === "claude");
    expect(claudeRow?.matrix.doctor).toBe(true);
    expect(claudeRow?.matrix.cancel).toBe(true);
    expect(claudeRow?.matrix.worktree_cwd).toBe(true);
  });

  it("createAdapter returns shell and generic for bound templates", async () => {
    const spawnImpl: SpawnImpl = async () => ({
      pid: 4242,
      wait: async () => ({ exit_code: 0, signal: null }),
      kill: () => undefined,
    });
    const registry = await AdapterRegistry.fromConfig(
      config({
        registry: [
          {
            id: "aider",
            binary: "/bin/aider",
            start_template: "{binary} --yes --model {model} {prompt_file}",
          },
        ],
      }),
      {
        platform: "linux",
        env: { PATH: "/bin" },
        exists: async (p) => p === "/bin/aider",
        spawnImpl,
      },
    );

    const shell = registry.createAdapter("shell");
    expect(shell?.id).toBe("shell");

    const aider = registry.createAdapter("aider");
    expect(aider?.id).toBe("aider");

    // unbound builtin → null
    expect(registry.createAdapter("agy")).toBeNull();
  });

  it("generic start uses start_template with injected spawn", async () => {
    let seenArgv: string[] | undefined;
    const spawnImpl: SpawnImpl = async (req) => {
      seenArgv = [...req.argv];
      return {
        pid: 99,
        wait: async () => ({ exit_code: 0, signal: null }),
        kill: () => undefined,
      };
    };

    const reg: AdapterRegistration = {
      id: "aider",
      display_name: "Aider",
      binary: "aider",
      binary_path: "/bin/aider",
      enabled: true,
      source: "user_config",
      capabilities: codingCapabilities(),
      start_template: "{binary} --model {model} {prompt_file}",
    };
    const registry = AdapterRegistry.fromRegistrations([reg], { spawnImpl });
    const adapter = registry.createAdapter("aider");
    expect(adapter).not.toBeNull();

    const sessionDir = "/tmp/sess";
    const running = await adapter!.start({
      agent_id: "agt_1",
      role: "worker",
      role_prompt: "do",
      skills: [],
      adapter_id: "aider",
      model: "gpt-4o",
      model_tier: "large",
      session_kind: "llm",
      cwd: "/repo",
      env: {},
      max_turns: 1,
      timeout_ms: 1000,
      approval_policy: "auto",
      context: {
        freeze_hash: "h",
        plan_dir: "/plan",
        run_id: "run_1",
        project_root: "/repo",
        feature_branch: "feat",
        context_kv: {},
      },
      session_dir: sessionDir,
      prompt_file: `${sessionDir}/prompt.md`,
    });

    expect(running.pid).toBe(99);
    expect(seenArgv).toEqual([
      "/bin/aider",
      "--model",
      "gpt-4o",
      `${sessionDir}/prompt.md`,
    ]);
    const result = await running.wait();
    expect(result.status).toBe("ok");
  });

  it("doctor all returns one result per adapter", async () => {
    const registry = await AdapterRegistry.fromConfig(config({}), {
      discover: false,
      execImpl: async () => ({ code: 0, stdout: "1.0.0", stderr: "" }),
    });
    // Without discovery all coding unbound; shell ok
    const results = await registry.doctor();
    expect(results.length).toBe(registry.list().length);
    expect(results.find((r) => r.adapter_id === "shell")?.ok).toBe(true);
  });

  it("upsert replaces in-memory registration", async () => {
    const registry = await AdapterRegistry.fromConfig(config({}), {
      discover: false,
    });
    registry.upsert({
      id: "custom",
      display_name: "Custom",
      binary: "custom",
      enabled: true,
      source: "user_config",
      capabilities: codingCapabilities(),
      start_template: "{binary} {prompt_file}",
    });
    expect(registry.get("custom")?.display_name).toBe("Custom");
    registry.upsert({
      id: "custom",
      display_name: "Custom v2",
      binary: "custom",
      enabled: false,
      source: "user_config",
      capabilities: codingCapabilities(),
    });
    expect(registry.get("custom")?.display_name).toBe("Custom v2");
    expect(registry.get("custom")?.enabled).toBe(false);
  });
});

describe("splitTemplateArgv", () => {
  it("splits quotes and whitespace", () => {
    expect(splitTemplateArgv(`foo --bar "a b" 'c d'`)).toEqual([
      "foo",
      "--bar",
      "a b",
      "c d",
    ]);
  });
});
