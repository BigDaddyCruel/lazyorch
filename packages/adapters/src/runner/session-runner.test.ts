import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createShellAdapter, type SpawnImpl } from "../shell/adapter.js";
import type { AgentAdapter, AgentSession, RunningAgent, SessionResult } from "../types.js";
import {
  createSessionRunner,
  SessionRunnerError,
} from "./session-runner.js";
import { readSessionsFile, sessionsFilePath } from "./sessions-table.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) await rm(d, { recursive: true, force: true });
  }
});

async function makeRunDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lazyorch-run-"));
  tempDirs.push(root);
  return root;
}

function baseSession(
  overrides: Partial<AgentSession> = {},
): AgentSession {
  return {
    agent_id: "agt_1",
    task_id: "tsk_1",
    role: "worker",
    role_prompt: "Do work",
    skills: [],
    adapter_id: "shell",
    model: "n/a",
    model_tier: null,
    session_kind: "deterministic",
    cwd: process.cwd(),
    env: { SAFE: "1", GH_TOKEN: "should-be-scrubbed" },
    max_turns: 1,
    timeout_ms: 15_000,
    approval_policy: "auto",
    context: {
      freeze_hash: "fh",
      plan_dir: "/plan",
      run_id: "run_test",
      project_root: "/repo",
      feature_branch: "feat",
      context_kv: {},
      task: {
        id: "tsk_1",
        title: "t",
        description: "d",
        scope: ["src/**"],
        acceptance: ["ok"],
        review_criteria: ["ok"],
        attempt: 0,
        max_attempts: 3,
      },
    },
    command: [process.execPath, "-e", "process.exit(0)"],
    ...overrides,
  };
}

describe("SessionRunner + real short shell", () => {
  it("materializes, registers pid, runs node, maps ok→review", async () => {
    const runDir = await makeRunDir();
    const shell = createShellAdapter({
      allowlist: {
        allowed_commands: ["node"],
        deny_patterns: [],
      },
    });
    // process.execPath basename may be "node.exe" → allowlist normalizes
    const runner = createSessionRunner({
      run_dir: runDir,
      run_id: "run_test",
      getAdapter: (id) => (id === "shell" ? shell : undefined),
      cancel_grace_ms: 0,
      enable_stall: false,
    });

    const managed = await runner.start({
      session: baseSession({
        command: [
          process.execPath,
          "-e",
          "process.stdout.write('done'); process.exit(0)",
        ],
      }),
      run_handle: "ses_ok",
    });

    expect(managed.pid).toBeGreaterThan(0);
    expect(managed.run_handle).toBe("ses_ok");

    const table = await readSessionsFile(sessionsFilePath(runDir));
    expect(table.sessions["ses_ok"]?.status).toBe("running");
    expect(table.sessions["ses_ok"]?.pid).toBe(managed.pid);

    const prompt = await readFile(
      join(runDir, "sessions", "ses_ok", "prompt.md"),
      "utf8",
    );
    expect(prompt).toContain("Do work");
    expect(prompt).not.toContain("should-be-scrubbed");

    const meta = JSON.parse(
      await readFile(join(runDir, "sessions", "ses_ok", "meta.json"), "utf8"),
    ) as { adapter_id: string; session_kind: string };
    expect(meta.adapter_id).toBe("shell");
    expect(meta.session_kind).toBe("deterministic");

    const result = await managed.wait();
    expect(result.status).toBe("ok");
    expect(result.exit_code).toBe(0);

    const effect = managed.taskEffect();
    expect(effect).toMatchObject({ kind: "transition", to: "review" });

    const after = await readSessionsFile(sessionsFilePath(runDir));
    expect(after.sessions["ses_ok"]?.status).toBe("ok");
    expect(after.sessions["ses_ok"]?.ended_at).toBeTruthy();
  });

  it("parses result.json and maps reviewer approve", async () => {
    const runDir = await makeRunDir();
    const sessionDir = join(runDir, "sessions", "ses_rev");
    // Pre-create session dir so the shell command can write result.json there via cwd.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(sessionDir, { recursive: true });

    const shell = createShellAdapter({
      allowlist: { allowed_commands: ["node"], deny_patterns: [] },
    });
    const runner = createSessionRunner({
      run_dir: runDir,
      run_id: "run_test",
      getAdapter: () => shell,
      cancel_grace_ms: 0,
      enable_stall: false,
    });

    const managed = await runner.start({
      session: baseSession({
        role: "reviewer",
        role_prompt: "Review",
        cwd: sessionDir,
        command: [
          process.execPath,
          "-e",
          `require('fs').writeFileSync('result.json', JSON.stringify({ kind: 'review', decision: 'approve' }));`,
        ],
      }),
      run_handle: "ses_rev",
    });

    const result = await managed.wait();
    expect(result.status).toBe("ok");
    expect(result.decision).toEqual({ kind: "review", decision: "approve" });
    expect(managed.taskEffect()).toMatchObject({
      kind: "transition",
      to: "integrating",
    });
  });
});

describe("SessionRunner with fake processes", () => {
  function fakeAdapter(opts: {
    pid?: number;
    waitMs?: number;
    exitCode?: number;
    onKill?: () => void;
    hang?: boolean;
  }): AgentAdapter {
    const live = new Map<string, { resolve: (r: SessionResult) => void }>();
    return {
      id: "fake",
      async doctor() {
        return { ok: true, adapter_id: "fake", message: "ok" };
      },
      async start(session: AgentSession): Promise<RunningAgent> {
        const run_handle = session.session_dir!.replace(/\\/g, "/").split("/").pop()!;
        const log_path = join(session.session_dir!, "stdio.log");
        await writeFile(log_path, "start\n", "utf8");
        let resolveWait!: (r: SessionResult) => void;
        const waitPromise = new Promise<SessionResult>((resolve) => {
          resolveWait = resolve;
        });
        live.set(run_handle, { resolve: resolveWait });

        if (!opts.hang) {
          setTimeout(() => {
            resolveWait({
              status: (opts.exitCode ?? 0) === 0 ? "ok" : "error",
              exit_code: opts.exitCode ?? 0,
              adapter_id: "fake",
            });
          }, opts.waitMs ?? 30);
        }

        return {
          run_handle,
          pid: opts.pid ?? 9999,
          adapter_id: "fake",
          agent_id: session.agent_id,
          task_id: session.task_id,
          session_dir: session.session_dir!,
          started_at: new Date().toISOString(),
          log_path,
          wait: () => waitPromise,
        };
      },
      async cancel(runHandle: string) {
        opts.onKill?.();
        const e = live.get(runHandle);
        e?.resolve({
          status: "cancelled",
          adapter_id: "fake",
          summary: "cancelled",
        });
      },
    };
  }

  it("applies timeout and kills process tree", async () => {
    const runDir = await makeRunDir();
    let killedPid: number | undefined;
    const adapter = fakeAdapter({ hang: true, pid: 5555 });
    const runner = createSessionRunner({
      run_dir: runDir,
      run_id: "run_test",
      getAdapter: () => adapter,
      cancel_grace_ms: 0,
      enable_stall: false,
      killTree: async (pid) => {
        killedPid = pid;
        await adapter.cancel("ses_to");
      },
    });

    const managed = await runner.start({
      session: baseSession({
        adapter_id: "fake",
        session_kind: "llm",
        model: "m",
        model_tier: "small",
        timeout_ms: 80,
        command: undefined,
      }),
      run_handle: "ses_to",
    });

    const result = await managed.wait();
    expect(result.status).toBe("timeout");
    expect(killedPid).toBe(5555);
    expect(managed.taskEffect()).toMatchObject({
      kind: "transition",
      to: "ready",
      increment_attempt: true,
    });
  });

  it("detects stall when log does not grow", async () => {
    const runDir = await makeRunDir();
    let killed = false;
    const adapter = fakeAdapter({ hang: true, pid: 7777, onKill: () => { killed = true; } });
    const runner = createSessionRunner({
      run_dir: runDir,
      run_id: "run_test",
      getAdapter: () => adapter,
      cancel_grace_ms: 0,
      enable_stall: true,
      stall_timeout_ms: 100,
      stall_poll_ms: 20,
      killTree: async () => {
        killed = true;
        await adapter.cancel("ses_stall");
      },
    });

    const managed = await runner.start({
      session: baseSession({
        adapter_id: "fake",
        session_kind: "llm",
        model: "m",
        model_tier: "small",
        timeout_ms: 60_000,
        command: undefined,
      }),
      run_handle: "ses_stall",
    });

    const result = await managed.wait();
    expect(result.status).toBe("stall");
    expect(killed).toBe(true);
  });

  it("cancel() yields cancelled status", async () => {
    const runDir = await makeRunDir();
    const adapter = fakeAdapter({ hang: true, pid: 8888 });
    const runner = createSessionRunner({
      run_dir: runDir,
      run_id: "run_test",
      getAdapter: () => adapter,
      cancel_grace_ms: 0,
      enable_stall: false,
      killTree: async () => {
        await adapter.cancel("ses_cancel");
      },
    });

    const managed = await runner.start({
      session: baseSession({
        adapter_id: "fake",
        session_kind: "llm",
        model: "m",
        model_tier: "small",
        timeout_ms: 60_000,
        command: undefined,
      }),
      run_handle: "ses_cancel",
    });

    const waitP = managed.wait();
    await managed.cancel("user");
    const result = await waitP;
    expect(result.status).toBe("cancelled");
  });

  it("hard-stops when agent hours budget exceeded", async () => {
    const runDir = await makeRunDir();
    let now = 0;
    const adapter = fakeAdapter({ waitMs: 5, pid: 1 });
    const runner = createSessionRunner({
      run_dir: runDir,
      run_id: "run_test",
      getAdapter: () => adapter,
      cancel_grace_ms: 0,
      enable_stall: false,
      now: () => now,
      budget: { max_agent_hours: 0.5, hard_stop: true },
    });

    // First session consumes 1h
    const m1 = await runner.start({
      session: baseSession({
        adapter_id: "fake",
        session_kind: "llm",
        model: "m",
        model_tier: "small",
        timeout_ms: 5000,
        command: undefined,
      }),
      run_handle: "ses_b1",
    });
    now = 3_600_000;
    await m1.wait();

    await expect(
      runner.start({
        session: baseSession({
          adapter_id: "fake",
          session_kind: "llm",
          model: "m",
          model_tier: "small",
          timeout_ms: 5000,
          command: undefined,
        }),
        run_handle: "ses_b2",
      }),
    ).rejects.toBeInstanceOf(SessionRunnerError);
  });

  it("throws when adapter missing", async () => {
    const runDir = await makeRunDir();
    const runner = createSessionRunner({
      run_dir: runDir,
      run_id: "run_test",
      getAdapter: () => undefined,
    });
    await expect(
      runner.start({ session: baseSession() }),
    ).rejects.toMatchObject({ code: "missing_adapter" });
  });
});

describe("SessionRunner shell allowlist via real adapter", () => {
  it("rejects disallowed command at adapter.start", async () => {
    const runDir = await makeRunDir();
    const shell = createShellAdapter();
    const runner = createSessionRunner({
      run_dir: runDir,
      run_id: "run_test",
      getAdapter: () => shell,
      cancel_grace_ms: 0,
      enable_stall: false,
    });
    await expect(
      runner.start({
        session: baseSession({
          command: ["curl", "http://evil.example"],
        }),
        run_handle: "ses_bad",
      }),
    ).rejects.toMatchObject({ code: "start" });
  });
});

describe("fake spawn shell through runner", () => {
  it("uses injected spawnImpl", async () => {
    const runDir = await makeRunDir();
    const spawnImpl: SpawnImpl = async (req) => {
      await writeFile(req.log_path, "fake-out\n", "utf8");
      return {
        pid: 321,
        wait: async () => ({ exit_code: 0, signal: null }),
        kill: () => undefined,
      };
    };
    const shell = createShellAdapter({
      spawnImpl,
      allowlist: { allowed_commands: ["node"], deny_patterns: [] },
    });
    const runner = createSessionRunner({
      run_dir: runDir,
      run_id: "run_test",
      getAdapter: () => shell,
      cancel_grace_ms: 0,
      enable_stall: false,
    });
    const managed = await runner.start({
      session: baseSession({
        command: ["node", "-e", "1"],
      }),
      run_handle: "ses_fake_spawn",
    });
    expect(managed.pid).toBe(321);
    const result = await managed.wait();
    expect(result.status).toBe("ok");
  });
});
