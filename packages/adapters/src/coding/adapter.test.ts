import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AdaptersConfigSchema } from "@lazyorch/shared";
import { AdapterRegistry } from "../registry/registry.js";
import type { SpawnImpl } from "../shell/adapter.js";
import type { AgentSession } from "../types.js";
import { createClaudeAdapter, claudeRegistration } from "../claude/index.js";
import { createCodexAdapter, codexRegistration } from "../codex/index.js";
import { createAgyAdapter, agyRegistration } from "../agy/index.js";
import { createGrokAdapter, grokRegistration } from "../grok/index.js";
import { BUILTIN_CATALOG } from "../registry/catalog.js";
import {
  buildCodingArgv,
  CodingArgvError,
  expandFlagTemplate,
} from "./argv.js";
import {
  CODING_PROFILES,
  FIRST_CLASS_CODING_IDS,
} from "./profiles.js";
import { StartRecorder } from "./fake.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) await rm(d, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "lazyorch-coding-"));
  tempDirs.push(d);
  return d;
}

function llmSession(
  sessionDir: string,
  overrides: Partial<AgentSession> = {},
): AgentSession {
  return {
    agent_id: "agt_code",
    role: "worker",
    role_prompt: "implement",
    skills: [],
    adapter_id: "claude",
    model: "claude-sonnet-4-6",
    model_tier: "large",
    session_kind: "llm",
    cwd: sessionDir,
    env: {},
    max_turns: 1,
    timeout_ms: 60_000,
    approval_policy: "auto",
    context: {
      freeze_hash: "h",
      plan_dir: join(sessionDir, "plan"),
      run_id: "run_x",
      project_root: sessionDir,
      feature_branch: "feat",
      context_kv: {},
    },
    session_dir: sessionDir,
    prompt_file: join(sessionDir, "prompt.md"),
    ...overrides,
  };
}

describe("expandFlagTemplate / buildCodingArgv", () => {
  it("expands model flag tokens", () => {
    expect(expandFlagTemplate("--model {model}", { model: "m1" })).toEqual([
      "--model",
      "m1",
    ]);
  });

  it("builds claude argv with print + permission mode + effort", () => {
    const session = llmSession("/tmp/s", {
      model: "claude-opus-4-6",
      effort: "high",
      prompt_file: "/tmp/s/prompt.md",
    });
    const argv = buildCodingArgv({
      profile: CODING_PROFILES.claude,
      registration: claudeRegistration({ binary_path: "/usr/bin/claude" }),
      session,
    });
    expect(argv).toEqual([
      "/usr/bin/claude",
      "--model",
      "claude-opus-4-6",
      "--effort",
      "high",
      "--print",
      "--permission-mode",
      "bypassPermissions",
      "/tmp/s/prompt.md",
    ]);
  });

  it("builds codex exec argv", () => {
    const session = llmSession("/tmp/s", {
      adapter_id: "codex",
      model: "o4-mini",
      prompt_file: "/tmp/s/prompt.md",
    });
    const argv = buildCodingArgv({
      profile: CODING_PROFILES.codex,
      registration: codexRegistration({ binary_path: "/bin/codex" }),
      session,
    });
    expect(argv).toEqual([
      "/bin/codex",
      "exec",
      "--model",
      "o4-mini",
      "/tmp/s/prompt.md",
    ]);
  });

  it("agy skips model flag for n/a (best-effort)", () => {
    const session = llmSession("/tmp/s", {
      adapter_id: "agy",
      model: "n/a",
      prompt_file: "/tmp/s/prompt.md",
    });
    const argv = buildCodingArgv({
      profile: CODING_PROFILES.agy,
      registration: agyRegistration(),
      session,
    });
    expect(argv).toEqual(["/bin/agy", "/tmp/s/prompt.md"]);
  });

  it("agy includes model when provided", () => {
    const session = llmSession("/tmp/s", {
      adapter_id: "agy",
      model: "agy-default",
      prompt_file: "/tmp/s/p.md",
    });
    const argv = buildCodingArgv({
      profile: CODING_PROFILES.agy,
      registration: agyRegistration({ binary_path: "/opt/agy" }),
      session,
    });
    expect(argv).toEqual(["/opt/agy", "--model", "agy-default", "/tmp/s/p.md"]);
  });

  it("builds grok argv", () => {
    const session = llmSession("/tmp/s", {
      adapter_id: "grok",
      model: "grok-3",
      prompt_file: "/tmp/s/prompt.md",
    });
    const argv = buildCodingArgv({
      profile: CODING_PROFILES.grok,
      registration: grokRegistration({ binary_path: "/bin/grok" }),
      session,
    });
    expect(argv).toEqual([
      "/bin/grok",
      "--model",
      "grok-3",
      "/tmp/s/prompt.md",
    ]);
  });

  it("required model profiles throw on empty or n/a", () => {
    const empty = llmSession("/tmp/s", { model: "", prompt_file: "/tmp/s/p.md" });
    expect(() =>
      buildCodingArgv({
        profile: CODING_PROFILES.claude,
        registration: claudeRegistration(),
        session: empty,
      }),
    ).toThrow(CodingArgvError);

    const na = llmSession("/tmp/s", { model: "n/a", prompt_file: "/tmp/s/p.md" });
    expect(() =>
      buildCodingArgv({
        profile: CODING_PROFILES.codex,
        registration: codexRegistration(),
        session: na,
      }),
    ).toThrow(CodingArgvError);

    try {
      buildCodingArgv({
        profile: CODING_PROFILES.grok,
        registration: grokRegistration(),
        session: na,
      });
      expect.fail("expected missing_model");
    } catch (e) {
      expect(e).toBeInstanceOf(CodingArgvError);
      expect((e as CodingArgvError).code).toBe("missing_model");
    }
  });

  it("honors custom start_template override", () => {
    const session = llmSession("/tmp/s", {
      model: "x",
      prompt_file: "/tmp/s/prompt.md",
    });
    const argv = buildCodingArgv({
      profile: CODING_PROFILES.claude,
      registration: claudeRegistration({
        binary_path: "/bin/claude",
        start_template: "{binary} --custom {model} {prompt_file}",
      }),
      session,
    });
    expect(argv).toEqual(["/bin/claude", "--custom", "x", "/tmp/s/prompt.md"]);
  });

  it("catalog start_template matches profile default for all coding ids", () => {
    for (const id of FIRST_CLASS_CODING_IDS) {
      const cat = BUILTIN_CATALOG.find((e) => e.id === id);
      expect(cat?.start_template).toBe(
        CODING_PROFILES[id].default_start_template,
      );
    }
  });
});

describe("CodingCliAdapter fake mode (all four)", () => {
  for (const id of FIRST_CLASS_CODING_IDS) {
    it(`${id}: fake start/cancel/wait + model flag argv`, async () => {
      const dir = await tempDir();
      await writeFile(join(dir, "prompt.md"), "do work\n", "utf8");
      const recorder = new StartRecorder();

      const factories = {
        claude: () =>
          createClaudeAdapter(claudeRegistration(), {
            mode: "fake",
            recorder,
          }),
        codex: () =>
          createCodexAdapter(codexRegistration(), {
            mode: "fake",
            recorder,
          }),
        agy: () =>
          createAgyAdapter(agyRegistration(), { mode: "fake", recorder }),
        grok: () =>
          createGrokAdapter(grokRegistration(), { mode: "fake", recorder }),
      } as const;

      const adapter = factories[id]();
      expect(adapter.id).toBe(id);
      expect(adapter.runMode).toBe("fake");

      const doctor = await adapter.doctor();
      expect(doctor.ok).toBe(true);
      expect(doctor.version).toBe("fake");

      const modelById: Record<string, string> = {
        claude: "claude-sonnet-4-6",
        codex: "o4-mini",
        agy: "agy-m",
        grok: "grok-3",
      };

      const agent = await adapter.start(
        llmSession(dir, {
          adapter_id: id,
          model: modelById[id]!,
          agent_id: `agt_${id}`,
        }),
      );

      expect(agent.pid).toBeGreaterThan(0);
      expect(agent.adapter_id).toBe(id);
      expect(agent.run_handle).toBe(dir.replace(/\\/g, "/").split("/").pop());

      const recorded = recorder.last();
      expect(recorded?.adapter_id).toBe(id);
      expect(recorded?.argv[0]).toMatch(/claude|codex|agy|grok/);
      if (id !== "agy" || modelById[id] !== "n/a") {
        expect(recorded?.argv).toContain("--model");
        expect(recorded?.argv).toContain(modelById[id]);
      }

      const argvJson = JSON.parse(
        await readFile(join(dir, "argv.json"), "utf8"),
      ) as { mode: string; argv: string[] };
      expect(argvJson.mode).toBe("fake");
      expect(argvJson.argv).toEqual([...recorded!.argv]);

      await adapter.cancel(agent.run_handle);
      const result = await agent.wait();
      expect(result.status).toBe("ok");
      expect(result.adapter_id).toBe(id);
      expect(result.usage?.input_tokens).toBe(10);
    });
  }

  it("rejects deterministic sessions", async () => {
    const dir = await tempDir();
    const a = createClaudeAdapter(claudeRegistration(), { mode: "fake" });
    await expect(
      a.start(
        llmSession(dir, {
          session_kind: "deterministic",
          model: "n/a",
          model_tier: null,
        }),
      ),
    ).rejects.toMatchObject({ code: "not_llm" });
  });

  it("live mode refuses unbound", async () => {
    const dir = await tempDir();
    const a = createAgyAdapter(
      agyRegistration({ unbound: true, binary_path: undefined }),
      { mode: "live" },
    );
    await expect(
      a.start(llmSession(dir, { adapter_id: "agy", model: "m" })),
    ).rejects.toMatchObject({ code: "unbound" });
  });

  it("record mode refuses unbound (same gate as live)", async () => {
    const dir = await tempDir();
    const a = createGrokAdapter(
      grokRegistration({ unbound: true }),
      { mode: "record" },
    );
    await expect(
      a.start(llmSession(dir, { adapter_id: "grok", model: "grok-3" })),
    ).rejects.toMatchObject({ code: "unbound" });
  });

  it("fake mode allows unbound", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "prompt.md"), "x\n", "utf8");
    const a = createAgyAdapter(
      agyRegistration({ unbound: true, binary: "agy" }),
      { mode: "fake" },
    );
    const agent = await a.start(llmSession(dir, { adapter_id: "agy", model: "m" }));
    const result = await agent.wait();
    expect(result.status).toBe("ok");
  });

  it("missing model on required adapter surfaces missing_model", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "prompt.md"), "x\n", "utf8");
    const a = createClaudeAdapter(claudeRegistration(), { mode: "fake" });
    await expect(
      a.start(llmSession(dir, { model: "n/a" })),
    ).rejects.toMatchObject({ code: "missing_model" });
  });
});

describe("CodingCliAdapter live with fake spawn + usage parse", () => {
  it("parses usage from stdio.log after exit", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "prompt.md"), "hi\n", "utf8");

    const spawnImpl: SpawnImpl = async (req) => {
      await writeFile(
        req.log_path,
        `${JSON.stringify({ usage: { input_tokens: 42, output_tokens: 7 } })}\n`,
        "utf8",
      );
      return {
        pid: 1234,
        wait: async () => ({ exit_code: 0, signal: null }),
        kill: () => undefined,
      };
    };

    const recorder = new StartRecorder();
    const adapter = createCodexAdapter(codexRegistration(), {
      mode: "record",
      spawnImpl,
      recorder,
    });

    const agent = await adapter.start(
      llmSession(dir, { adapter_id: "codex", model: "gpt-5" }),
    );
    expect(recorder.last()?.mode).toBe("record");
    expect(recorder.last()?.argv).toEqual([
      "/bin/codex",
      "exec",
      "--model",
      "gpt-5",
      join(dir, "prompt.md"),
    ]);

    const result = await agent.wait();
    expect(result.status).toBe("ok");
    expect(result.usage).toEqual({ input_tokens: 42, output_tokens: 7 });
  });

  it("preserves vendor API keys in live spawn env", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "prompt.md"), "hi\n", "utf8");
    let seenEnv: Record<string, string> | undefined;
    const spawnImpl: SpawnImpl = async (req) => {
      seenEnv = req.env;
      return {
        pid: 55,
        wait: async () => ({ exit_code: 0, signal: null }),
        kill: () => undefined,
      };
    };
    const prevAnthropic = process.env.ANTHROPIC_API_KEY;
    const prevGh = process.env.GH_TOKEN;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.GH_TOKEN = "ghp_should_not_pass";
    try {
      const adapter = createClaudeAdapter(
        claudeRegistration({
          env: { OPENAI_API_KEY: "sk-from-reg", MY_FLAG: "1" },
        }),
        { mode: "live", spawnImpl, skip_usage_parse: true },
      );
      const agent = await adapter.start(
        llmSession(dir, { model: "claude-sonnet-4-6" }),
      );
      await agent.wait();
      expect(seenEnv?.ANTHROPIC_API_KEY).toBe("sk-ant-test");
      expect(seenEnv?.OPENAI_API_KEY).toBe("sk-from-reg");
      expect(seenEnv?.MY_FLAG).toBe("1");
      expect(seenEnv?.GH_TOKEN).toBeUndefined();
    } finally {
      if (prevAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnthropic;
      if (prevGh === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = prevGh;
    }
  });

  it("maps signal kill to cancelled", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "prompt.md"), "hi\n", "utf8");
    const spawnImpl: SpawnImpl = async () => ({
      pid: 9,
      wait: async () => ({ exit_code: null, signal: "SIGTERM" }),
      kill: () => undefined,
    });
    const adapter = createGrokAdapter(grokRegistration(), {
      mode: "live",
      spawnImpl,
      skip_usage_parse: true,
    });
    const agent = await adapter.start(
      llmSession(dir, { adapter_id: "grok", model: "grok-4" }),
    );
    const result = await agent.wait();
    expect(result.status).toBe("cancelled");
  });
});

describe("AdapterRegistry.createAdapter coding path", () => {
  it("returns CodingCliAdapter for bound first-class ids", async () => {
    const recorder = new StartRecorder();
    const registry = await AdapterRegistry.fromConfig(
      AdaptersConfigSchema.parse({}),
      {
        platform: "linux",
        env: { PATH: "/bin" },
        exists: async (p) =>
          p === "/bin/claude" || p === "/bin/codex" || p === "/bin/grok",
        codingMode: "fake",
        codingRecorder: recorder,
      },
    );

    const claude = registry.createAdapter("claude");
    expect(claude?.id).toBe("claude");
    expect(registry.createCoding("claude")?.runMode).toBe("fake");

    const codex = registry.createCoding("codex");
    expect(codex?.id).toBe("codex");

    // unbound agy still creatable in fake mode
    const agy = registry.createAdapter("agy");
    expect(agy?.id).toBe("agy");

    // live would null unbound
    const liveReg = await AdapterRegistry.fromConfig(
      AdaptersConfigSchema.parse({}),
      {
        platform: "linux",
        env: { PATH: "/bin" },
        exists: async () => false,
        codingMode: "live",
      },
    );
    expect(liveReg.createAdapter("claude")).toBeNull();
    expect(liveReg.createAdapter("agy")).toBeNull();

    // record also nulls unbound
    const recordReg = await AdapterRegistry.fromConfig(
      AdaptersConfigSchema.parse({}),
      {
        platform: "linux",
        env: { PATH: "/bin" },
        exists: async () => false,
        codingMode: "record",
      },
    );
    expect(recordReg.createAdapter("agy")).toBeNull();

    // generic for user ids only
    expect(registry.createGeneric("claude")).toBeNull();
  });

  it("LAZYORCH_ADAPTER_MODE=fake creates unbound without codingMode option", async () => {
    const prev = process.env.LAZYORCH_ADAPTER_MODE;
    process.env.LAZYORCH_ADAPTER_MODE = "fake";
    try {
      const registry = await AdapterRegistry.fromConfig(
        AdaptersConfigSchema.parse({}),
        {
          platform: "linux",
          env: { PATH: "/bin" },
          exists: async () => false,
          // codingMode intentionally omitted — env drives mode
        },
      );
      expect(registry.effectiveCodingMode()).toBe("fake");
      const agy = registry.createCoding("agy");
      expect(agy).not.toBeNull();
      expect(agy!.runMode).toBe("fake");
      expect(registry.get("agy")?.unbound).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.LAZYORCH_ADAPTER_MODE;
      else process.env.LAZYORCH_ADAPTER_MODE = prev;
    }
  });

  it("createGeneric still serves user registry adapters", async () => {
    const spawnImpl: SpawnImpl = async () => ({
      pid: 1,
      wait: async () => ({ exit_code: 0, signal: null }),
      kill: () => undefined,
    });
    const registry = await AdapterRegistry.fromConfig(
      AdaptersConfigSchema.parse({
        registry: [
          {
            id: "aider",
            binary: "/bin/aider",
            start_template: "{binary} --model {model} {prompt_file}",
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
    const gen = registry.createGeneric("aider");
    expect(gen?.id).toBe("aider");
  });

  it("listModels on default claude returns [] without models_args (not tier_map)", async () => {
    const a = createClaudeAdapter(
      claudeRegistration({
        capabilities: {
          models: [],
          tier_map: {
            small: "claude-haiku-4-5",
            medium: "claude-sonnet-4-6",
            large: "claude-sonnet-4-6",
            xlarge: "claude-opus-4-6",
          },
          streaming: false,
          worktree_ok: true,
          usage_reporting: "tokens_and_cost",
          effort_flag: true,
        },
      }),
      { mode: "fake" },
    );
    // Empty capabilities.models + no models_args → unspecified, not allowlist.
    await expect(a.listModels()).resolves.toEqual([]);
  });
});
