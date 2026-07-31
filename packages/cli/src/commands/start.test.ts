import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { SCHEMA_VERSION } from "@lazyorch/core";
import { runStart } from "./start.js";
import { EXIT } from "../exit-codes.js";

const temps: string[] = [];

async function tempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lazyorch-cli-start-"));
  temps.push(dir);
  const lazy = join(dir, ".lazyorch");
  await mkdir(lazy, { recursive: true });
  await writeFile(
    join(lazy, "project.json"),
    JSON.stringify({
      schema_version: SCHEMA_VERSION,
      id: "proj_starttest",
      repo_root: dir,
      name: "start-test",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    }),
    "utf8",
  );
  return dir;
}

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

afterEach(async () => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("runStart", () => {
  it("creates a run from idea", async () => {
    const repo = await tempRepo();
    const streams = capture();
    const res = await runStart({
      idea: "build a widget",
      repo,
      nextId: () => "run_aaaaaaaaaaaaaaaaaaaaaaaa",
      now: () => "2026-02-01T00:00:00.000Z",
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(res.exitCode).toBe(EXIT.OK);
    expect(res.run?.id).toBe("run_aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(res.run?.phase).toBe("Inception");
    expect(res.run?.idea).toBe("build a widget");
    const body = JSON.parse(streams.stdout.text) as { run_id: string };
    expect(body.run_id).toBe("run_aaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("reads idea from file", async () => {
    const repo = await tempRepo();
    const ideaPath = join(repo, "idea.md");
    await writeFile(ideaPath, "  from file idea  \n", "utf8");
    const streams = capture();
    const res = await runStart({
      ideaFile: ideaPath,
      repo,
      nextId: () => "run_bbbbbbbbbbbbbbbbbbbbbbbb",
      now: () => "2026-02-01T00:00:00.000Z",
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(res.exitCode).toBe(EXIT.OK);
    expect(res.run?.idea).toBe("from file idea");
  });

  it("usage when idea missing", async () => {
    const repo = await tempRepo();
    const streams = capture();
    const res = await runStart({
      repo,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(res.exitCode).toBe(EXIT.USAGE);
  });

  it("errors without project.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lazyorch-cli-start-empty-"));
    temps.push(dir);
    const streams = capture();
    const res = await runStart({
      idea: "x",
      repo: dir,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(res.exitCode).toBe(EXIT.ERROR);
    expect(res.message).toBe("no_project");
  });
});
