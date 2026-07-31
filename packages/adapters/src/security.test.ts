/**
 * Private-beta security invariants: secret scrubbing across env, prompts,
 * shell spawn, and coding CLI spawn. Complements unit tests in scrub.test.ts.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPromptMarkdown,
  materializeSession,
} from "./runner/materialize.js";
import { createShellAdapter, type SpawnImpl } from "./shell/adapter.js";
import { scrubCodingSpawnEnv, scrubEnv, scrubText } from "./scrub.js";
import type { AgentSession } from "./types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) await rm(d, { recursive: true, force: true });
  }
});

function baseSession(
  sessionDir: string,
  overrides: Partial<AgentSession> = {},
): AgentSession {
  return {
    agent_id: "agt_sec",
    task_id: "tsk_sec",
    role: "worker",
    role_prompt:
      "Implement feature. Never print secrets. Example leak: ghp_abcdefghijklmnopqrstuvwxyz12",
    skills: [],
    adapter_id: "shell",
    model: "n/a",
    model_tier: null,
    session_kind: "deterministic",
    cwd: sessionDir,
    env: {
      SAFE: "1",
      GH_TOKEN: "ghp_should_never_land",
      LAZYORCH_GITHUB_TOKEN: "lo-secret",
      OPENAI_API_KEY: "sk-should-not-forward-shell",
    },
    max_turns: 1,
    timeout_ms: 15_000,
    approval_policy: "auto",
    context: {
      freeze_hash: "fh",
      plan_dir: join(sessionDir, "plan"),
      run_id: "run_sec",
      project_root: sessionDir,
      feature_branch: "feat",
      context_kv: {
        note: "ok",
        bad: "token sk-abcdefghijklmnopqrstuvwxyz in kv",
      },
      task: {
        id: "tsk_sec",
        title: "secure task",
        description: "no secrets in description",
        scope: ["src/**"],
        acceptance: ["tests pass"],
        review_criteria: ["review"],
      },
    },
    command: [process.execPath, "-e", "process.exit(0)"],
    session_dir: sessionDir,
    ...overrides,
  };
}

describe("security: env scrubbing", () => {
  it("session.env never retains orchestrator / API secrets after scrubEnv", () => {
    const env = {
      PATH: "/usr/bin",
      GH_TOKEN: "x",
      GITHUB_TOKEN: "y",
      LAZYORCH_HOME: "/tmp",
      ANTHROPIC_API_KEY: "sk-ant",
      MY_APP_TOKEN: "t",
      NODE_ENV: "test",
    };
    const clean = scrubEnv(env);
    expect(Object.keys(clean).sort()).toEqual(["NODE_ENV", "PATH"]);
  });

  it("coding spawn keeps vendor keys only for live CLIs, not GH/LAZYORCH", () => {
    const out = scrubCodingSpawnEnv(
      {
        ANTHROPIC_API_KEY: "sk-ant-live",
        GH_TOKEN: "ghp_nope",
        LAZYORCH_DAEMON_TOKEN: "daemon",
        PATH: "/bin",
      },
      { SESSION: "1", OPENAI_API_KEY: "from-session" },
      { OPENAI_API_KEY: "from-reg", GH_TOKEN: "still-nope" },
    );
    expect(out.ANTHROPIC_API_KEY).toBe("sk-ant-live");
    expect(out.OPENAI_API_KEY).toBe("from-reg");
    expect(out.SESSION).toBe("1");
    expect(out.PATH).toBe("/bin");
    expect(out.GH_TOKEN).toBeUndefined();
    expect(out.LAZYORCH_DAEMON_TOKEN).toBeUndefined();
  });
});

describe("security: prompt / materialize redaction", () => {
  it("buildPromptMarkdown redacts token-shaped substrings in role and context", () => {
    const dir = "/tmp/sec-prompt";
    const md = buildPromptMarkdown(baseSession(dir), []);
    expect(md).toContain("# Role: worker");
    expect(md).not.toMatch(/ghp_[A-Za-z0-9_]+/);
    expect(md).not.toMatch(/sk-[A-Za-z0-9_-]{20,}/);
    expect(md).toContain("[REDACTED]");
  });

  it("materializeSession writes scrubbed prompt.md and never embeds env secrets in meta", async () => {
    const root = await mkdtemp(join(tmpdir(), "lazyorch-sec-"));
    tempDirs.push(root);
    const session_dir = join(root, "ses_sec");
    const session = baseSession(session_dir);

    const result = await materializeSession({
      session_dir,
      run_handle: "ses_sec",
      session: {
        ...session,
        env: scrubEnv(session.env),
      },
      started_at: "2026-01-01T00:00:00.000Z",
    });

    const prompt = await readFile(result.prompt_file, "utf8");
    const metaRaw = await readFile(result.meta_file, "utf8");

    expect(prompt).not.toMatch(/ghp_[A-Za-z0-9_]+/);
    expect(prompt).not.toContain("ghp_should_never_land");
    expect(prompt).not.toContain("lo-secret");
    expect(metaRaw).not.toContain("ghp_");
    expect(metaRaw).not.toContain("GH_TOKEN");
    expect(metaRaw).not.toContain("OPENAI_API_KEY");
    expect(metaRaw).not.toContain("should_never");
  });
});

describe("security: shell spawn env", () => {
  it("does not forward secret keys into child process env", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lazyorch-sec-shell-"));
    tempDirs.push(dir);

    let capturedEnv: Record<string, string> | undefined;
    const spawnImpl: SpawnImpl = async (req) => {
      capturedEnv = { ...req.env };
      return {
        pid: 4242,
        wait: async () => ({ exit_code: 0, signal: null }),
        kill: async () => {},
      };
    };

    const shell = createShellAdapter({
      allowlist: { allowed_commands: ["node"], deny_patterns: [] },
      spawnImpl,
    });

    const prevToken = process.env.GH_TOKEN;
    const prevLazy = process.env.LAZYORCH_TEST_TOKEN;
    process.env.GH_TOKEN = "ghp_from_process_env_abcdefghij";
    process.env.LAZYORCH_TEST_TOKEN = "lazy-from-process";

    try {
      const agent = await shell.start(
        baseSession(dir, {
          env: {
            SAFE: "yes",
            GITHUB_TOKEN: "from-session",
            OPENAI_API_KEY: "sk-session",
          },
          command: [process.execPath, "-e", "process.exit(0)"],
        }),
      );
      await agent.wait();
    } finally {
      if (prevToken === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = prevToken;
      if (prevLazy === undefined) delete process.env.LAZYORCH_TEST_TOKEN;
      else process.env.LAZYORCH_TEST_TOKEN = prevLazy;
    }

    expect(capturedEnv).toBeDefined();
    expect(capturedEnv!.SAFE).toBe("yes");
    expect(capturedEnv!.GH_TOKEN).toBeUndefined();
    expect(capturedEnv!.GITHUB_TOKEN).toBeUndefined();
    expect(capturedEnv!.OPENAI_API_KEY).toBeUndefined();
    expect(capturedEnv!.LAZYORCH_TEST_TOKEN).toBeUndefined();
  });
});

describe("security: log text redaction helper", () => {
  it("scrubText is safe for operator log display of mixed agent output", () => {
    const agentStdout = [
      "Cloning into worktree…",
      "Using token ghp_abcdefghijklmnopqrstuvwxyz12 for remote",
      "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz",
      "Done.",
    ].join("\n");
    const display = scrubText(agentStdout);
    expect(display).toContain("Cloning into worktree");
    expect(display).toContain("Done.");
    expect(display).not.toMatch(/ghp_[A-Za-z0-9_]+/);
    expect(display).not.toMatch(/sk-[A-Za-z0-9_-]{20,}/);
  });
});
