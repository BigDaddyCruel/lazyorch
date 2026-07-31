import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@lazyorch/daemon";
import { runLogs } from "./logs.js";
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

const sample: EventEnvelope[] = [
  {
    schema_version: 1,
    ts: "2026-01-01T00:00:00.000Z",
    project_id: "proj_x",
    run_id: "run_logs1aaaaaaaaaaaaaaaaaaaa",
    type: "phase.changed",
    payload: { from: "Inception", to: "Planning" },
  },
  {
    schema_version: 1,
    ts: "2026-01-01T00:01:00.000Z",
    project_id: "proj_x",
    run_id: "run_logs1aaaaaaaaaaaaaaaaaaaa",
    type: "gate.required",
    payload: { gate_id: "gate_x" },
  },
];

describe("runLogs", () => {
  it("reads events via injectable reader", async () => {
    const streams = capture();
    const res = await runLogs({
      run: "run_logs1aaaaaaaaaaaaaaaaaaaa",
      repo: "C:\\fake\\repo",
      resolvePath: () => "C:\\fake\\repo\\.lazyorch\\events\\run.jsonl",
      readEvents: async () => sample,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(res.exitCode).toBe(EXIT.OK);
    expect(res.events).toHaveLength(2);
    const body = JSON.parse(streams.stdout.text) as { count: number };
    expect(body.count).toBe(2);
  });

  it("applies limit", async () => {
    const streams = capture();
    const res = await runLogs({
      resolvePath: () => "/tmp/events.jsonl",
      readEvents: async () => sample,
      limit: 1,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(res.exitCode).toBe(EXIT.OK);
    expect(res.events).toHaveLength(1);
    expect(res.events[0]?.type).toBe("gate.required");
  });

  it("follow prints JSONL lines and stops at maxPolls", async () => {
    const streams = capture();
    let calls = 0;
    const res = await runLogs({
      follow: true,
      resolvePath: () => "/tmp/events.jsonl",
      readEvents: async () => {
        calls += 1;
        if (calls === 1) return [sample[0]!];
        return sample;
      },
      pollMs: 0,
      maxPolls: 1,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(res.exitCode).toBe(EXIT.OK);
    const lines = streams.stdout.text.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });
});
