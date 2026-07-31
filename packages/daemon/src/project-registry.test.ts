import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { ProjectRegistry } from "./project-registry.js";
import { projectsRegistryPath } from "./paths.js";

const temps: string[] = [];

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lazyorch-reg-"));
  temps.push(dir);
  return dir;
}

afterEach(async () => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("ProjectRegistry", () => {
  it("registers multiple projects and lists them", async () => {
    const home = await tempHome();
    const reg = new ProjectRegistry(home);

    const a = await reg.register({
      id: "proj_a",
      repo_root: join(home, "proj-a"),
      name: "A",
    });
    const b = await reg.register({
      id: "proj_b",
      repo_root: join(home, "proj-b"),
      name: "B",
    });

    expect(a.id).toBe("proj_a");
    expect(b.name).toBe("B");

    const list = await reg.list();
    expect(list.map((p) => p.id).sort()).toEqual(["proj_a", "proj_b"]);
    expect(await reg.getById("proj_a")).toMatchObject({ name: "A" });
    expect(await reg.getById("proj_b")).toMatchObject({ name: "B" });
    expect((await reg.getByRoot(b.repo_root))?.id).toBe("proj_b");

    // file on disk
    expect(reg.filePath).toBe(projectsRegistryPath(home));
  });

  it("updates existing by root without changing id", async () => {
    const home = await tempHome();
    const reg = new ProjectRegistry(home);
    const root = join(home, "repo");
    await reg.register({ id: "proj_1", repo_root: root, name: "Old" });
    const updated = await reg.register({
      id: "proj_other",
      repo_root: root,
      name: "New",
    });
    expect(updated.id).toBe("proj_1");
    expect(updated.name).toBe("New");
    expect(await reg.list()).toHaveLength(1);
  });

  it("unregisters by id", async () => {
    const home = await tempHome();
    const reg = new ProjectRegistry(home);
    await reg.register({ id: "proj_x", repo_root: join(home, "x") });
    expect(await reg.unregister("proj_x")).toBe(true);
    expect(await reg.list()).toHaveLength(0);
    expect(await reg.unregister("proj_x")).toBe(false);
  });
});
