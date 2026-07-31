import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createShellAdapter,
  ShellAdapterError,
  type SpawnImpl,
} from "./adapter.js";
import type { AgentSession } from "../types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) await rm(d, { recursive: true, force: true });
  }
});

function detSession(
  sessionDir: string,
  command: string[],
  overrides: Partial<AgentSession> = {},
): AgentSession {
  return {
    agent_id: "agt_shell",
    role: "worker",
    role_prompt: "run command",
    skills: [],
    adapter_id: "shell",
    model: "n/a",
    model_tier: null,
    session_kind: "deterministic",
    cwd: sessionDir,
    env: {},
    max_turns: 1,
    timeout_ms: 30_000,
    approval_policy: "auto",
    context: {
      freeze_hash: "h",
      plan_dir: join(sessionDir, "plan"),
      run_id: "run_x",
      project_root: sessionDir,
      feature_branch: "feat",
      context_kv: {},
    },
    command,
    session_dir: sessionDir,
    prompt_file: join(sessionDir, "prompt.md"),
    ...overrides,
  };
}

describe("ShellAdapter", () => {
  it("doctor reports ready with empty models", async () => {
    const a = createShellAdapter();
    const d = await a.doctor();
    expect(d.ok).toBe(true);
    expect(d.adapter_id).toBe("shell");
    expect(await a.listModels()).toEqual([]);
  });

  it("rejects non-deterministic sessions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lazyorch-shell-"));
    tempDirs.push(dir);
    const a = createShellAdapter();
    await expect(
      a.start(
        detSession(dir, ["node", "-e", "0"], {
          session_kind: "llm",
          model: "gpt",
          model_tier: "small",
        }),
      ),
    ).rejects.toMatchObject({ code: "not_deterministic" });
  });

  it("rejects commands outside allowlist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lazyorch-shell-"));
    tempDirs.push(dir);
    const a = createShellAdapter();
    await expect(
      a.start(detSession(dir, ["rm", "-rf", "/tmp"])),
    ).rejects.toBeInstanceOf(ShellAdapterError);
  });

  it("runs a short node command and captures exit 0", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lazyorch-shell-"));
    tempDirs.push(dir);
    const a = createShellAdapter();
    const agent = await a.start(
      detSession(dir, [
        process.execPath,
        "-e",
        "process.stdout.write('hi'); process.exit(0)",
      ]),
    );
    expect(agent.pid).toBeGreaterThan(0);
    expect(agent.adapter_id).toBe("shell");
    const result = await agent.wait();
    expect(result.status).toBe("ok");
    expect(result.exit_code).toBe(0);
    expect(result.model_used).toBe("n/a");
    const log = await readFile(agent.log_path, "utf8");
    expect(log).toContain("hi");
  });

  it("maps non-zero exit to error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lazyorch-shell-"));
    tempDirs.push(dir);
    const a = createShellAdapter();
    const agent = await a.start(
      detSession(dir, [process.execPath, "-e", "process.exit(7)"]),
    );
    const result = await agent.wait();
    expect(result.status).toBe("error");
    expect(result.exit_code).toBe(7);
  });

  it("supports fake spawn for unit tests", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lazyorch-shell-"));
    tempDirs.push(dir);
    let killed = false;
    const spawnImpl: SpawnImpl = async () => ({
      pid: 4242,
      wait: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { exit_code: killed ? null : 0, signal: killed ? "SIGTERM" : null };
      },
      kill: () => {
        killed = true;
      },
    });
    const a = createShellAdapter({
      spawnImpl,
      allowlist: {
        allowed_commands: ["node"],
        deny_patterns: [],
      },
    });
    const agent = await a.start(
      detSession(dir, ["node", "-e", "1"], { agent_id: "agt_fake" }),
    );
    expect(agent.pid).toBe(4242);
    await agent.wait();
    await a.cancel(agent.run_handle); // already finished — no-op
  });

  it("maps signal-killed exit to cancelled (not error)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lazyorch-shell-"));
    tempDirs.push(dir);
    const spawnImpl: SpawnImpl = async () => ({
      pid: 99,
      wait: async () => ({ exit_code: null, signal: "SIGTERM" }),
      kill: () => undefined,
    });
    const a = createShellAdapter({
      spawnImpl,
      allowlist: { allowed_commands: ["node"], deny_patterns: [] },
    });
    const agent = await a.start(detSession(dir, ["node", "-e", "1"]));
    const result = await agent.wait();
    expect(result.status).toBe("cancelled");
    expect(result.exit_code).toBeUndefined();
  });
});
