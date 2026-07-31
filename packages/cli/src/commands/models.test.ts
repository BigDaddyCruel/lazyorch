import { describe, expect, it } from "vitest";
import type { DryRunRouteResult } from "@lazyorch/core";
import { runModels } from "./models.js";
import { EXIT } from "../exit-codes.js";

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

  it("usage for unknown subcommand", async () => {
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
