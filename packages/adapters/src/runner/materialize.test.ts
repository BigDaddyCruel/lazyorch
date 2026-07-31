import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPromptMarkdown,
  materializeSession,
  substituteStartTemplate,
} from "./materialize.js";
import type { AgentSession } from "../types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) await rm(d, { recursive: true, force: true });
  }
});

function baseSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    agent_id: "agt_1",
    task_id: "tsk_1",
    role: "worker",
    role_prompt: "You are a worker.",
    skills: ["careful"],
    adapter_id: "shell",
    model: "n/a",
    model_tier: null,
    session_kind: "deterministic",
    cwd: "/repo",
    env: {},
    max_turns: 1,
    timeout_ms: 60_000,
    approval_policy: "auto",
    context: {
      freeze_hash: "abc123",
      plan_dir: "/repo/.lazyorch/plans/run_1",
      run_id: "run_1",
      project_root: "/repo",
      feature_branch: "lazyorch/run_1/feature",
      context_kv: { note: "hello" },
      task: {
        id: "tsk_1",
        title: "Do it",
        description: "Implement feature",
        scope: ["src/**"],
        acceptance: ["tests pass"],
        review_criteria: ["typecheck"],
      },
    },
    command: ["node", "-e", "process.exit(0)"],
    ...overrides,
  };
}

describe("buildPromptMarkdown", () => {
  it("includes role, skills, freeze, task, context, contract", () => {
    const md = buildPromptMarkdown(baseSession(), ["# careful\nBe careful."]);
    expect(md).toContain("# Role: worker");
    expect(md).toContain("You are a worker.");
    expect(md).toContain("## Skills");
    expect(md).toContain("Be careful.");
    expect(md).toContain("freeze_hash");
    expect(md).toContain("abc123");
    expect(md).toContain("## Task");
    expect(md).toContain("Do it");
    expect(md).toContain("## Context");
    expect(md).toContain('"note": "hello"');
    expect(md).toContain("## Output contract");
    expect(md).toContain("submitted");
  });
});

describe("materializeSession", () => {
  it("writes prompt.md and meta.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lazyorch-mat-"));
    tempDirs.push(dir);
    const session_dir = join(dir, "ses_test");
    const result = await materializeSession({
      session_dir,
      run_handle: "ses_test",
      session: baseSession(),
      started_at: "2026-01-01T00:00:00.000Z",
      skill_markdown: { careful: "# careful skill" },
    });
    const prompt = await readFile(result.prompt_file, "utf8");
    const metaRaw = await readFile(result.meta_file, "utf8");
    const meta = JSON.parse(metaRaw) as { run_handle: string; model_tier: null };
    expect(prompt).toContain("careful skill");
    expect(meta.run_handle).toBe("ses_test");
    expect(meta.model_tier).toBeNull();
  });
});

describe("substituteStartTemplate", () => {
  it("replaces placeholders", () => {
    const out = substituteStartTemplate(
      "{binary} {args_prefix} --model {model} --file {prompt_file}",
      {
        cwd: "/c",
        model: "gpt",
        prompt_file: "/p/prompt.md",
        session_dir: "/p",
        timeout_ms: 1000,
        binary: "claude",
        args_prefix: ["--yes"],
      },
    );
    expect(out).toBe("claude --yes --model gpt --file /p/prompt.md");
  });
});
