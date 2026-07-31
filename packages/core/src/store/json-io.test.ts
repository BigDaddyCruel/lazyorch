import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readJsonFile, writeJsonFile } from "./json-io.js";

describe("json-io", () => {
  it("round-trips JSON with trailing newline", async () => {
    const root = await mkdtemp(join(tmpdir(), "lazyorch-json-"));
    const path = join(root, "nested", "data.json");
    await writeJsonFile(path, { hello: "world", n: 1 });
    expect(await readJsonFile<{ hello: string; n: number }>(path)).toEqual({
      hello: "world",
      n: 1,
    });
  });

  it("readJsonFile returns null for missing files", async () => {
    const root = await mkdtemp(join(tmpdir(), "lazyorch-json-miss-"));
    expect(await readJsonFile(join(root, "nope.json"))).toBeNull();
  });

  it("cleans up temp files when rename fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "lazyorch-json-fail-"));
    // Place a directory where the target file should be so rename fails.
    const target = join(root, "out.json");
    await mkdir(target);

    await expect(writeJsonFile(target, { a: 1 })).rejects.toThrow();

    const names = await readdir(root);
    expect(names.filter((n) => n.endsWith(".tmp"))).toEqual([]);
    // directory still present (failed target)
    expect(names).toContain("out.json");
  });
});
