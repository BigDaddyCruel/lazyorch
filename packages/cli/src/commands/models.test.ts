import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import {
  SCHEMA_VERSION,
  StateStore,
  type DryRunRouteResult,
} from "@lazyorch/core";
import { runModels } from "./models.js";
import { RUN_PIN_CONTEXT_KEY } from "../run-pin.js";
import { EXIT } from "../exit-codes.js";

const temps: string[] = [];

function capture(): {
  stdout: NodeJS.WritableStream & { text: string };
  stderr: NodeJS.WritableStream & { text: string };
} {
  const out = { text: "", write(s: string) { this.text += s; return true; } };
  const err = { text: "", write(s: string) { this.text += s; return true; } };
  return {
    stdout: out as NodeJS.WritableStream & { text: string },
    stderr: err as NodeJS.WritableStream & { text: string },
  };
}

function fakeResult(
  overrides: Partial<DryRunRouteResult> = {},
): DryRunRouteResult {
  return {
    session_kind: "llm",
    tier: "medium",
    adapter_id: "claude",
    model: "default",
    reason: "estimate",
    floor_violated: false,
    pin_locked: false,
    score: 40,
    dry_run: true,
    event: {
      role: "worker",
      adapter_id: "claude",
      model: "default",
      reason: "estimate",
      tier: "medium",
    },
    ...overrides,
  };
}

afterEach(async () => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("runModels", () => {
  it("dry-runs route with injectable router", async () => {
    const streams = capture();
    const res = await runModels({
      action: "route",
      role: "worker",
      task: "tsk_aaaaaaaaaaaaaaaaaaaaaaaa",
      dryRun: () => fakeResult({ score: 55, tier: "large" }),
      loadConfig: async () => undefined,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(res.exitCode).toBe(EXIT.OK);
    expect(res.result?.tier).toBe("large");
    const body = JSON.parse(streams.stdout.text) as {
      dry_run: boolean;
      adapter_id: string;
    };
    expect(body.dry_run).toBe(true);
    expect(body.adapter_id).toBe("claude");
  });

  it("uses real dryRunRoute by default", async () => {
    const streams = capture();
    const res = await runModels({
      action: "route",
      role: "worker",
      loadConfig: async () => undefined,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(res.exitCode).toBe(EXIT.OK);
    expect(res.result?.adapter_id).toBeTruthy();
    expect(res.result?.dry_run).toBe(true);
  });

  it("maps adapter errors to exit 4", async () => {
    const streams = capture();
    const res = await runModels({
      action: "route",
      role: "worker",
      dryRun: () =>
        fakeResult({
          error: "no healthy adapter available",
          adapter_id: "",
          model: "",
        }),
      loadConfig: async () => undefined,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(res.exitCode).toBe(EXIT.ADAPTER_MISSING);
  });

  it("rejects invalid --tier", async () => {
    const streams = capture();
    const res = await runModels({
      action: "route",
      tier: "huge",
      loadConfig: async () => undefined,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(res.exitCode).toBe(EXIT.USAGE);
  });

  it("loads run_pin from context when --run set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lazyorch-cli-models-"));
    temps.push(dir);
    await mkdir(join(dir, ".lazyorch"), { recursive: true });
    const store = new StateStore(join(dir, ".lazyorch"));
    const runId = "run_models1aaaaaaaaaaaaaaaaaaa";
    await store.writeRun({
      schema_version: SCHEMA_VERSION,
      id: runId,
      project_id: "p",
      phase: "Inception",
      idea: "x",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    await store.setContextKey(runId, RUN_PIN_CONTEXT_KEY, {
      tier_override: "large",
      adapter_override: "codex",
    });

    const streams = capture();
    let seenPin: unknown;
    const res = await runModels({
      action: "route",
      run: runId,
      repo: dir,
      dryRun: (params) => {
        seenPin = params.run_pin;
        return fakeResult({
          tier: "large",
          adapter_id: "codex",
          reason: "override",
          pin_locked: true,
        });
      },
      loadConfig: async () => undefined,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(res.exitCode).toBe(EXIT.OK);
    expect(seenPin).toEqual({
      tier_override: "large",
      adapter_override: "codex",
    });
  });

  it("usage for bad signals json", async () => {
    const streams = capture();
    const res = await runModels({
      action: "route",
      signalsJson: "{not-json",
      loadConfig: async () => undefined,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(res.exitCode).toBe(EXIT.USAGE);
  });
});
