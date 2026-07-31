import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { runInit } from "./init.js";
import { SCHEMA_VERSION } from "@lazyorch/shared";

const temps: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lazyorch-init-"));
  temps.push(dir);
  return dir;
}

function silentStdout(): NodeJS.WritableStream {
  return { write: () => true } as unknown as NodeJS.WritableStream;
}

afterEach(async () => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("runInit", () => {
  it("creates config.yml and project.json", async () => {
    const root = await tempRoot();
    const result = await runInit({
      repo: root,
      name: "demo",
      stdout: silentStdout(),
    });

    expect(result.created).toHaveLength(2);
    expect(result.skipped).toEqual([]);
    expect(result.projectId).toMatch(/^proj_[0-9a-f]{24}$/);

    const projectRaw = await readFile(result.projectPath, "utf8");
    const project = JSON.parse(projectRaw) as {
      schema_version: number;
      id: string;
      name: string;
      repo_root: string;
    };
    expect(project.schema_version).toBe(SCHEMA_VERSION);
    expect(project.id).toBe(result.projectId);
    expect(project.name).toBe("demo");
    expect(project.repo_root).toBe(root);

    const yaml = await readFile(result.configPath, "utf8");
    expect(yaml).toMatch(/max_concurrent_agents:\s*8/);
    expect(yaml).toMatch(/max_workers:\s*4/);
    expect(yaml).toMatch(/name:\s*demo/);
  });

  it("skip preserves existing projectId (no phantom id)", async () => {
    const root = await tempRoot();
    const first = await runInit({
      repo: root,
      name: "demo",
      stdout: silentStdout(),
    });
    const second = await runInit({
      repo: root,
      name: "demo",
      stdout: silentStdout(),
    });

    expect(second.skipped.length).toBeGreaterThan(0);
    expect(second.projectId).toBe(first.projectId);

    const onDisk = JSON.parse(
      await readFile(first.projectPath, "utf8"),
    ) as { id: string };
    expect(second.projectId).toBe(onDisk.id);
  });

  it("--force overwrites and issues a new project id", async () => {
    const root = await tempRoot();
    const first = await runInit({
      repo: root,
      name: "demo",
      stdout: silentStdout(),
    });
    const forced = await runInit({
      repo: root,
      name: "renamed",
      force: true,
      stdout: silentStdout(),
    });

    expect(forced.created).toHaveLength(2);
    expect(forced.skipped).toEqual([]);
    expect(forced.projectId).not.toBe(first.projectId);

    const project = JSON.parse(
      await readFile(forced.projectPath, "utf8"),
    ) as { id: string; name: string };
    expect(project.id).toBe(forced.projectId);
    expect(project.name).toBe("renamed");
  });
});
