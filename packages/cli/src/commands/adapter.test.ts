import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInit } from "./init.js";
import { runAdapter } from "./adapter.js";

const temps: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lazyorch-adapter-cli-"));
  temps.push(dir);
  return dir;
}

function silent(): NodeJS.WritableStream {
  return { write: () => true } as unknown as NodeJS.WritableStream;
}

afterEach(async () => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("runAdapter CLI", () => {
  it("list after init shows builtins + shell", async () => {
    const root = await tempRoot();
    await runInit({ repo: root, name: "demo", stdout: silent() });
    const result = await runAdapter({
      action: "list",
      repo: root,
      skipProbe: true,
      stdout: silent(),
      stderr: silent(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.matrix).toBeDefined();
    const ids = result.matrix!.adapters.map((a) => a.id);
    expect(ids).toEqual(
      expect.arrayContaining(["claude", "codex", "agy", "grok", "shell"]),
    );
    expect(
      result.matrix!.adapters.find((a) => a.id === "shell")?.status,
    ).toBe("ok");
  });

  it("register writes registry entry to config.yml", async () => {
    const root = await tempRoot();
    await runInit({ repo: root, name: "demo", stdout: silent() });
    const result = await runAdapter({
      action: "register",
      repo: root,
      id: "aider",
      binary: "aider",
      displayName: "Aider",
      startTemplate: "{binary} --model {model} {prompt_file}",
      stdout: silent(),
      stderr: silent(),
    });
    expect(result.exitCode).toBe(0);
    const yaml = await readFile(join(root, ".lazyorch", "config.yml"), "utf8");
    expect(yaml).toMatch(/id:\s*aider/);
    expect(yaml).toMatch(/binary:\s*aider/);
  });

  it("test shell returns ok", async () => {
    const root = await tempRoot();
    await runInit({ repo: root, name: "demo", stdout: silent() });
    const result = await runAdapter({
      action: "test",
      repo: root,
      id: "shell",
      stdout: silent(),
      stderr: silent(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.registration?.id).toBe("shell");
  });

  it("test unknown id fails", async () => {
    const root = await tempRoot();
    await runInit({ repo: root, name: "demo", stdout: silent() });
    const result = await runAdapter({
      action: "test",
      repo: root,
      id: "nope",
      stdout: silent(),
      stderr: silent(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/unknown adapter/);
  });

  it("register requires id and binary", async () => {
    const root = await tempRoot();
    await runInit({ repo: root, name: "demo", stdout: silent() });
    const noId = await runAdapter({
      action: "register",
      repo: root,
      binary: "x",
      stdout: silent(),
      stderr: silent(),
    });
    expect(noId.exitCode).toBe(1);
    const noBin = await runAdapter({
      action: "register",
      repo: root,
      id: "x",
      stdout: silent(),
      stderr: silent(),
    });
    expect(noBin.exitCode).toBe(1);
  });
});
