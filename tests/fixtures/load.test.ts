import { describe, expect, it } from "vitest";
import { extractRunHandle } from "@lazyorch/adapters";
import {
  assertFixtureShape,
  expectedAdapterFixtureIds,
  extractRunHandle as fixtureExtractRunHandle,
  loadAdapterFakeFixture,
  loadMaterializedAdapterFixture,
} from "./load.js";

function minimalValid(adapterId = "claude") {
  return {
    schema_version: 1,
    adapter_id: adapterId,
    mode: "fake",
    session: {
      model: "m1",
      model_tier: "large",
      role: "worker",
      session_kind: "llm",
    },
    recorded_start: {
      adapter_id: adapterId,
      run_handle: "{run_handle}",
      argv: ["/bin/claude", "--model", "m1", "{prompt_file}"],
      cwd: "{cwd}",
      model: "m1",
      session_dir: "{session_dir}",
      started_at: "2026-01-01T00:00:00.000Z",
      mode: "fake",
      prompt_file: "{prompt_file}",
    },
    session_result: {
      status: "ok",
      exit_code: 0,
      adapter_id: adapterId,
      model_used: "m1",
      summary: "ok",
      usage: { input_tokens: 1, output_tokens: 2 },
    },
  };
}

describe("assertFixtureShape", () => {
  it("accepts a minimal valid fixture", () => {
    const f = assertFixtureShape(minimalValid(), "mem:claude", "claude");
    expect(f.adapter_id).toBe("claude");
    expect(f.recorded_start.argv).toHaveLength(4);
  });

  it("rejects wrong schema_version", () => {
    expect(() =>
      assertFixtureShape(
        { ...minimalValid(), schema_version: 2 },
        "mem",
        "claude",
      ),
    ).toThrow(/schema_version/);
  });

  it("rejects wrong mode", () => {
    expect(() =>
      assertFixtureShape({ ...minimalValid(), mode: "live" }, "mem", "claude"),
    ).toThrow(/mode "fake"/);
  });

  it("rejects unknown adapter_id", () => {
    expect(() =>
      assertFixtureShape(
        { ...minimalValid("not-real"), adapter_id: "not-real" },
        "mem",
      ),
    ).toThrow(/unknown adapter_id/);
  });

  it("rejects adapter_id mismatch with expected filename id", () => {
    expect(() =>
      assertFixtureShape(minimalValid("claude"), "mem", "codex"),
    ).toThrow(/does not match expected "codex"/);
  });

  it("rejects missing recorded_start keys / empty argv", () => {
    const bad = minimalValid();
    bad.recorded_start.argv = [];
    expect(() => assertFixtureShape(bad, "mem", "claude")).toThrow(
      /non-empty string\[\]/,
    );
  });

  it("rejects missing session.model", () => {
    const bad = minimalValid() as unknown as Record<string, unknown>;
    bad.session = {
      model_tier: "large",
      role: "worker",
      session_kind: "llm",
    };
    expect(() => assertFixtureShape(bad, "mem", "claude")).toThrow(
      /session.model/,
    );
  });

  it("rejects invalid model_tier", () => {
    const bad = minimalValid() as unknown as {
      session: { model_tier: string };
    } & ReturnType<typeof minimalValid>;
    bad.session.model_tier = "huge";
    expect(() => assertFixtureShape(bad, "mem", "claude")).toThrow(
      /model_tier/,
    );
  });

  it("rejects invalid session_result.status", () => {
    const bad = minimalValid() as unknown as {
      session_result: { status: string };
    } & ReturnType<typeof minimalValid>;
    bad.session_result.status = "nope";
    expect(() => assertFixtureShape(bad, "mem", "claude")).toThrow(
      /session_result.status/,
    );
  });

  it("rejects recorded_start.adapter_id drift", () => {
    const bad = minimalValid("claude");
    bad.recorded_start.adapter_id = "codex";
    expect(() => assertFixtureShape(bad, "mem", "claude")).toThrow(
      /recorded_start.adapter_id/,
    );
  });
});

describe("extractRunHandle alignment", () => {
  it("matches production adapter for trailing separators", () => {
    expect(fixtureExtractRunHandle).toBe(extractRunHandle);
    expect(extractRunHandle("/tmp/foo")).toBe("foo");
    expect(extractRunHandle("/tmp/foo/")).toBe("unknown");
    expect(extractRunHandle("C:\\Users\\x\\sess\\")).toBe("unknown");
    expect(extractRunHandle("C:\\Users\\x\\sess")).toBe("sess");
  });

  it("materializes run_handle with production rules", async () => {
    // Use on-disk claude fixture; expand with trailing slash → unknown
    const mat = await loadMaterializedAdapterFixture("claude", {
      session_dir: "/tmp/sess_abc/",
    });
    expect(mat.recorded_start.run_handle).toBe("unknown");
    expect(mat.recorded_start.session_dir).toBe("/tmp/sess_abc/");
  });
});

describe("on-disk fixtures", () => {
  it("loads every first-class coding adapter sample", async () => {
    for (const id of expectedAdapterFixtureIds()) {
      const f = await loadAdapterFakeFixture(id);
      expect(f.adapter_id).toBe(id);
      expect(f.mode).toBe("fake");
      expect(f.recorded_start.argv.length).toBeGreaterThan(0);
    }
  });
});
