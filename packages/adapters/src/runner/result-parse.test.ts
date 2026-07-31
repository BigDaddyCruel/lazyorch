import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseLastStdoutJsonLine,
  parseStructuredDecision,
  resolveStructuredDecision,
} from "./result-parse.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) await rm(d, { recursive: true, force: true });
  }
});

describe("parseStructuredDecision", () => {
  it("parses explicit and implicit shapes", () => {
    expect(
      parseStructuredDecision({ kind: "worker", submitted: true }),
    ).toEqual({ kind: "worker", submitted: true });
    expect(parseStructuredDecision({ decision: "approve" })).toEqual({
      kind: "review",
      decision: "approve",
    });
    expect(parseStructuredDecision({ passed: false, summary: "x" })).toEqual({
      kind: "qa",
      passed: false,
      summary: "x",
    });
    expect(parseStructuredDecision({ foo: 1 })).toBeNull();
  });
});

describe("parseLastStdoutJsonLine", () => {
  it("uses last JSON line", () => {
    const stdout = "noise\n{bad\n" + JSON.stringify({ submitted: true }) + "\n";
    expect(parseLastStdoutJsonLine(stdout)).toEqual({
      kind: "worker",
      submitted: true,
    });
  });
});

describe("resolveStructuredDecision", () => {
  it("prefers result.json over stdout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lazyorch-res-"));
    tempDirs.push(dir);
    await writeFile(
      join(dir, "result.json"),
      JSON.stringify({ kind: "review", decision: "reject" }),
      "utf8",
    );
    const r = await resolveStructuredDecision(
      dir,
      JSON.stringify({ kind: "review", decision: "approve" }),
    );
    expect(r.decision).toEqual({ kind: "review", decision: "reject" });
    expect(r.raw_result_path).toContain("result.json");
  });
});
