import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearSession,
  countRunningSessions,
  readSessionsFile,
  registerSession,
  sessionsFilePath,
  updateSessionRecord,
} from "./sessions-table.js";
import type { SessionRecord } from "../types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) await rm(d, { recursive: true, force: true });
  }
});

function rec(handle: string, status: SessionRecord["status"] = "running"): SessionRecord {
  return {
    run_handle: handle,
    pid: 1,
    adapter_id: "shell",
    agent_id: "agt_1",
    role: "worker",
    started_at: new Date().toISOString(),
    session_dir: `/tmp/${handle}`,
    log_path: `/tmp/${handle}/stdio.log`,
    status,
  };
}

describe("sessions table", () => {
  it("registers, updates, clears, counts running", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lazyorch-ses-"));
    tempDirs.push(dir);
    const path = sessionsFilePath(dir);

    await registerSession(path, rec("a"));
    await registerSession(path, rec("b"));
    let file = await readSessionsFile(path);
    expect(countRunningSessions(file)).toBe(2);

    await updateSessionRecord(path, "a", {
      status: "ok",
      ended_at: new Date().toISOString(),
    });
    file = await readSessionsFile(path);
    expect(file.sessions["a"]?.status).toBe("ok");
    expect(countRunningSessions(file)).toBe(1);

    await clearSession(path, "b");
    file = await readSessionsFile(path);
    expect(file.sessions["b"]).toBeUndefined();
  });

  it("concurrent register keeps all handles (mutex)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lazyorch-ses-"));
    tempDirs.push(dir);
    const path = sessionsFilePath(dir);
    const handles = Array.from({ length: 24 }, (_, i) => `ses_${i}`);
    await Promise.all(handles.map((h) => registerSession(path, rec(h))));
    const file = await readSessionsFile(path);
    for (const h of handles) {
      expect(file.sessions[h]).toBeDefined();
    }
    expect(Object.keys(file.sessions)).toHaveLength(24);
    expect(countRunningSessions(file)).toBe(24);
  });
});
