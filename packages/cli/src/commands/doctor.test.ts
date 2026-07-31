import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { runInit } from "./init.js";
import { runDoctor } from "./doctor.js";

const temps: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lazyorch-doctor-"));
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

describe("runDoctor", () => {
  it("healthy after init (exit 0; packing ok; adapters may warn)", async () => {
    const root = await tempRoot();
    await runInit({ repo: root, name: "demo", stdout: silentStdout() });
    const result = await runDoctor({
      repo: root,
      ci: false,
      stdout: silentStdout(),
    });

    expect(result.exitCode).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.config).not.toBeNull();
    expect(
      result.findings.some((f) => f.code === "slot_packing" && f.level === "ok"),
    ).toBe(true);
    // Missing adapter binaries are warnings only
    const adapterFails = result.findings.filter(
      (f) => f.code.includes("adapter") && f.level === "error",
    );
    expect(adapterFails).toEqual([]);
  });

  it("missing .lazyorch → exit 1", async () => {
    const root = await tempRoot();
    const result = await runDoctor({
      repo: root,
      ci: false,
      stdout: silentStdout(),
    });
    expect(result.exitCode).toBe(1);
    expect(
      result.findings.some((f) => f.code === "no_lazyorch_dir"),
    ).toBe(true);
  });

  it("slot packing failure → exit 1", async () => {
    const root = await tempRoot();
    await runInit({ repo: root, name: "demo", stdout: silentStdout() });
    const lazy = join(root, ".lazyorch");
    await writeFile(
      join(lazy, "config.yml"),
      `elasticity:\n  max_workers: 10\nscheduling:\n  max_concurrent_agents: 5\nreserve_slots:\n  lead: 1\nteam:\n  min_reviewers: 1\n  min_qa: 1\n`,
      "utf8",
    );

    const result = await runDoctor({
      repo: root,
      ci: false,
      stdout: silentStdout(),
    });
    expect(result.exitCode).toBe(1);
    expect(
      result.findings.some(
        (f) => f.code === "slot_packing" && f.level === "error",
      ),
    ).toBe(true);
    // No peak warn when min packing already fails
    expect(
      result.findings.some(
        (f) => f.level === "warn" && f.message.includes("peak"),
      ),
    ).toBe(false);
  });

  it("schema failure → exit 1", async () => {
    const root = await tempRoot();
    const lazy = join(root, ".lazyorch");
    await mkdir(lazy, { recursive: true });
    await writeFile(
      join(lazy, "project.json"),
      JSON.stringify({
        schema_version: 1,
        id: "proj_abc",
        repo_root: root,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      }),
      "utf8",
    );
    await writeFile(
      join(lazy, "config.yml"),
      "elasticity:\n  max_worker: 4\n",
      "utf8",
    );

    const result = await runDoctor({
      repo: root,
      ci: false,
      stdout: silentStdout(),
    });
    expect(result.exitCode).toBe(1);
    expect(
      result.findings.some((f) => f.code === "config_invalid"),
    ).toBe(true);
  });

  it("incomplete project.json → exit 1", async () => {
    const root = await tempRoot();
    const lazy = join(root, ".lazyorch");
    await mkdir(lazy, { recursive: true });
    await writeFile(
      join(lazy, "project.json"),
      JSON.stringify({ schema_version: 1 }),
      "utf8",
    );
    await writeFile(join(lazy, "config.yml"), "project:\n  name: x\n", "utf8");

    const result = await runDoctor({
      repo: root,
      ci: false,
      stdout: silentStdout(),
    });
    expect(result.exitCode).toBe(1);
    expect(
      result.findings.some((f) => f.code === "project_json_invalid"),
    ).toBe(true);
  });

  it("CI + explicit timeout_action none → warn", async () => {
    const root = await tempRoot();
    await runInit({ repo: root, name: "demo", stdout: silentStdout() });
    // init writes timeout_action: none by default
    const result = await runDoctor({
      repo: root,
      ci: true,
      stdout: silentStdout(),
    });
    // Schema still valid; explicit none preserved with CI warn
    expect(
      result.findings.some((f) => f.code === "ci_timeout" && f.level === "warn"),
    ).toBe(true);
    // Should still be healthy (warn only) unless adapters/other errors
    expect(result.findings.some((f) => f.code === "config_schema")).toBe(true);
  });

  it("init YAML round-trips through doctor", async () => {
    const root = await tempRoot();
    await runInit({ repo: root, name: "roundtrip", stdout: silentStdout() });
    const result = await runDoctor({
      repo: root,
      ci: false,
      stdout: silentStdout(),
    });
    expect(result.ok).toBe(true);
    expect(result.config?.project.name).toBe("roundtrip");
  });
});
