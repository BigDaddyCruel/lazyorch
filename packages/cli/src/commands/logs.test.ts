import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import type { EventEnvelope } from "@lazyorch/daemon";
import {
  applyEventLimit,
  formatLogLine,
  formatLogsJson,
  readEventJsonlReadonly,
  runLogs,
} from "./logs.js";
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

afterEach(async () => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

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

  it("applies limit 1", async () => {
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

  it("limit 0 means empty (not full array)", async () => {
    const streams = capture();
    let reads = 0;
    const res = await runLogs({
      resolvePath: () => "/tmp/events.jsonl",
      readEvents: async () => {
        reads += 1;
        return sample;
      },
      limit: 0,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(res.exitCode).toBe(EXIT.OK);
    expect(res.events).toHaveLength(0);
    expect(JSON.parse(streams.stdout.text).count).toBe(0);
    // short-circuit: no need to read file for limit 0
    expect(reads).toBe(0);
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

describe("readEventJsonlReadonly", () => {
  it("skips torn last line without mutating file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lazyorch-logs-ro-"));
    temps.push(dir);
    const path = join(dir, "events.jsonl");
    const good = JSON.stringify(sample[0]);
    const original = `${good}\n{"partial torn`;
    await writeFile(path, original, "utf8");

    const events = await readEventJsonlReadonly(path);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("phase.changed");

    // File must be unchanged
    const after = await readFile(path, "utf8");
    expect(after).toBe(original);
  });
});

describe("applyEventLimit", () => {
  it("handles 0 / 1 / undefined", () => {
    expect(applyEventLimit(sample, 0)).toEqual([]);
    expect(applyEventLimit(sample, 1)).toHaveLength(1);
    expect(applyEventLimit(sample, undefined)).toHaveLength(2);
  });
});

describe("logs display redaction", () => {
  it("formatLogsJson redacts token-shaped values without mutating events", () => {
    const payload = {
      events: [
        {
          type: "log.line",
          msg: "auth ghp_abcdefghijklmnopqrstuvwxyz12",
        },
      ],
    };
    const out = formatLogsJson(payload, false);
    expect(out).not.toMatch(/ghp_[A-Za-z0-9_]+/);
    expect(out).toContain("[REDACTED]");
    // source object unchanged
    expect(payload.events[0]!.msg).toContain("ghp_");
  });

  it("formatLogLine redacts follow-mode lines", () => {
    const line = formatLogLine(
      JSON.stringify({
        type: "log.line",
        msg: "key sk-abcdefghijklmnopqrstuvwxyz",
      }),
    );
    expect(line).not.toMatch(/sk-[A-Za-z0-9_-]{20,}/);
    expect(line).toContain("[REDACTED]");
    expect(line.endsWith("\n")).toBe(true);
  });

  it("runLogs stdout redacts secrets in event payloads", async () => {
    const streams = capture();
    const secretEvents: EventEnvelope[] = [
      {
        schema_version: 1,
        ts: "2026-01-01T00:00:00.000Z",
        project_id: "proj_x",
        run_id: "run_logs1aaaaaaaaaaaaaaaaaaaa",
        type: "log.line",
        payload: { line: "token ghp_abcdefghijklmnopqrstuvwxyz12" },
      },
    ];
    const res = await runLogs({
      resolvePath: () => "/tmp/events.jsonl",
      readEvents: async () => secretEvents,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(res.exitCode).toBe(EXIT.OK);
    expect(streams.stdout.text).not.toMatch(/ghp_[A-Za-z0-9_]+/);
    expect(streams.stdout.text).toContain("[REDACTED]");
    // in-memory events remain unredacted (durable truth for callers)
    expect(JSON.stringify(res.events)).toContain("ghp_");
  });
});
