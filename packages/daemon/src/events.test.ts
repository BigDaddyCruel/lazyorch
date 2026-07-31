import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import {
  EventBus,
  appendEventJsonl,
  createEvent,
  readEventJsonl,
  ensureEventsDir,
} from "./events.js";
import { eventJsonlPath } from "./paths.js";

const temps: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lazyorch-ev-"));
  temps.push(dir);
  return dir;
}

afterEach(async () => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("events JSONL", () => {
  it("appends and reads events for a run", async () => {
    const root = await tempRoot();
    await ensureEventsDir(root);

    const e1 = createEvent({
      project_id: "proj_1",
      run_id: "run_abc",
      type: "phase.changed",
      payload: { from: "Inception", to: "Planning" },
      id: "1",
    });
    const e2 = createEvent({
      project_id: "proj_1",
      run_id: "run_abc",
      type: "task.updated",
      payload: { task_id: "tsk_1" },
      id: "2",
    });

    const path = await appendEventJsonl({
      repoRoot: root,
      event: e1,
      fsync: false,
    });
    expect(path).toBe(eventJsonlPath(root, "run_abc"));
    await appendEventJsonl({ repoRoot: root, event: e2, fsync: false });

    const events = await readEventJsonl(path);
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("phase.changed");
    expect(events[1]?.payload).toEqual({ task_id: "tsk_1" });
  });

  it("uses _global when run_id omitted", async () => {
    const root = await tempRoot();
    const e = createEvent({
      project_id: "proj_1",
      type: "project.registered",
      payload: {},
    });
    const path = await appendEventJsonl({
      repoRoot: root,
      event: e,
      fsync: false,
    });
    expect(path).toBe(eventJsonlPath(root));
    expect(await readEventJsonl(path)).toHaveLength(1);
  });

  it("truncates torn last line on read", async () => {
    const root = await tempRoot();
    const path = eventJsonlPath(root, "run_x");
    await mkdir(join(root, ".lazyorch", "events"), { recursive: true });
    const good = createEvent({
      project_id: "p",
      run_id: "run_x",
      type: "log.line",
      payload: { line: "ok" },
    });
    await writeFile(
      path,
      `${JSON.stringify(good)}\n{"type":"torn partial`,
      "utf8",
    );
    const events = await readEventJsonl(path);
    expect(events).toHaveLength(1);
    // re-read after truncate
    expect(await readEventJsonl(path)).toHaveLength(1);
  });
});

describe("EventBus", () => {
  it("fans out with generated ids", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const unsub = bus.subscribe((e) => {
      if (e.id) seen.push(e.id);
    });
    bus.publish(
      createEvent({ project_id: "p", type: "daemon.started", payload: {} }),
    );
    bus.publish(
      createEvent({ project_id: "p", type: "error", payload: { msg: "x" } }),
    );
    expect(seen).toEqual(["1", "2"]);
    unsub();
    bus.publish(
      createEvent({ project_id: "p", type: "error", payload: {} }),
    );
    expect(seen).toEqual(["1", "2"]);
  });
});

describe("eventJsonlPath safety", () => {
  it("rejects path traversal run_ids", async () => {
    const root = await tempRoot();
    expect(() => eventJsonlPath(root, "../../evil")).toThrow(/Invalid run_id/);
    expect(() => eventJsonlPath(root, "..")).toThrow(/Invalid run_id/);
    expect(() => eventJsonlPath(root, "a/b")).toThrow(/Invalid run_id/);
    expect(() => eventJsonlPath(root, "a\\b")).toThrow(/Invalid run_id/);
  });
});
