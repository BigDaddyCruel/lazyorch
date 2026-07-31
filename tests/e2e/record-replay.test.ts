/**
 * E2E record/replay: first-class coding adapters in fake mode, driven by
 * tests/fixtures/adapters/<id>.fake.json (no live LLM binaries or API keys).
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  StartRecorder,
  createAgyAdapter,
  createClaudeAdapter,
  createCodexAdapter,
  createGrokAdapter,
  agyRegistration,
  claudeRegistration,
  codexRegistration,
  grokRegistration,
  type AgentSession,
  type CodingCliAdapter,
  type FirstClassCodingId,
  type SessionResult,
} from "@lazyorch/adapters";
import type { ModelTier } from "@lazyorch/shared";
import {
  expectedAdapterFixtureIds,
  loadAdapterFakeFixture,
  loadMaterializedAdapterFixture,
} from "../fixtures/load.js";

const tempDirs: string[] = [];

const MODEL_TIERS = new Set<string>([
  "nano",
  "small",
  "medium",
  "large",
  "xlarge",
]);

afterEach(async () => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) await rm(d, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "lazyorch-e2e-rr-"));
  tempDirs.push(d);
  return d;
}

function createFakeAdapter(
  id: FirstClassCodingId,
  opts: {
    recorder: StartRecorder;
    fakeResult: SessionResult;
  },
): CodingCliAdapter {
  const common = {
    mode: "fake" as const,
    recorder: opts.recorder,
    fakeResult: opts.fakeResult,
  };
  switch (id) {
    case "claude":
      return createClaudeAdapter(claudeRegistration(), common);
    case "codex":
      return createCodexAdapter(codexRegistration(), common);
    case "agy":
      return createAgyAdapter(agyRegistration(), common);
    case "grok":
      return createGrokAdapter(grokRegistration(), common);
    default: {
      const _exhaustive: never = id;
      throw new Error(`unsupported adapter ${_exhaustive}`);
    }
  }
}

function parseTier(value: string | null): ModelTier | null {
  if (value === null) return null;
  if (MODEL_TIERS.has(value)) return value as ModelTier;
  return "medium";
}

function llmSession(
  sessionDir: string,
  adapterId: FirstClassCodingId,
  model: string,
  modelTier: ModelTier | null,
): AgentSession {
  return {
    agent_id: `agt_${adapterId}`,
    role: "worker",
    role_prompt: "implement",
    skills: [],
    adapter_id: adapterId,
    model,
    model_tier: modelTier,
    session_kind: "llm",
    cwd: sessionDir,
    env: {},
    max_turns: 1,
    timeout_ms: 60_000,
    approval_policy: "auto",
    context: {
      freeze_hash: "fixture_hash",
      plan_dir: join(sessionDir, "plan"),
      run_id: "run_e2e_fixture",
      project_root: sessionDir,
      feature_branch: "lazyorch/run_e2e_fixture/feature",
      context_kv: {},
    },
    session_dir: sessionDir,
    prompt_file: join(sessionDir, "prompt.md"),
  };
}

describe("fixtures inventory", () => {
  it("has a fake-mode sample for every first-class coding adapter", async () => {
    const ids = expectedAdapterFixtureIds();
    expect(ids).toEqual(["claude", "codex", "agy", "grok"]);
    for (const id of ids) {
      const f = await loadAdapterFakeFixture(id);
      expect(f.adapter_id).toBe(id);
      expect(f.mode).toBe("fake");
      expect(f.recorded_start.adapter_id).toBe(id);
      expect(f.session_result.status).toBe("ok");
      expect(f.session_result.adapter_id).toBe(id);
      expect(f.recorded_start.argv.length).toBeGreaterThan(0);
      expect(f.recorded_start.argv[0]).toContain(id === "claude" ? "claude" : id);
    }
  });
});

describe("adapter fake record/replay from fixtures", () => {
  for (const id of expectedAdapterFixtureIds()) {
    it(`${id}: replays canned result and matches recorded argv shape`, async () => {
      const raw = await loadAdapterFakeFixture(id);
      const dir = await tempDir();
      await writeFile(join(dir, "prompt.md"), "e2e fixture prompt\n", "utf8");

      const expected = await loadMaterializedAdapterFixture(id, {
        session_dir: dir,
      });

      const recorder = new StartRecorder();
      const adapter = createFakeAdapter(id, {
        recorder,
        fakeResult: raw.session_result,
      });

      expect(adapter.runMode).toBe("fake");
      const doctor = await adapter.doctor();
      expect(doctor.ok).toBe(true);
      expect(doctor.version).toBe("fake");

      const agent = await adapter.start(
        llmSession(dir, id, raw.session.model, parseTier(raw.session.model_tier)),
      );

      expect(agent.adapter_id).toBe(id);
      expect(agent.pid).toBeGreaterThan(0);

      const recorded = recorder.last();
      expect(recorded).toBeDefined();
      expect(recorded!.adapter_id).toBe(id);
      expect(recorded!.mode).toBe("fake");
      expect(recorded!.model).toBe(raw.session.model);
      // Argv shape from fixture (paths expanded to this session dir)
      expect(recorded!.argv).toEqual(expected.recorded_start.argv);

      const result = await agent.wait();
      expect(result.status).toBe(raw.session_result.status);
      expect(result.adapter_id).toBe(id);
      expect(result.model_used).toBe(raw.session.model);
      expect(result.summary).toBe(raw.session_result.summary);
      expect(result.usage?.input_tokens).toBe(
        raw.session_result.usage?.input_tokens,
      );
      expect(result.usage?.output_tokens).toBe(
        raw.session_result.usage?.output_tokens,
      );
    });
  }
});
