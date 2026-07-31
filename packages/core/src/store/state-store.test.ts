import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateId } from "@lazyorch/shared";
import { SCHEMA_VERSION } from "../schema.js";
import type { Gate } from "../types/gate.js";
import type { Project } from "../types/project.js";
import type { Run } from "../types/run.js";
import type { Task } from "../types/task.js";
import { StateStore } from "./state-store.js";

describe("StateStore", () => {
  it("round-trips project, run, task, gates", async () => {
    const root = await mkdtemp(join(tmpdir(), "lazyorch-state-"));
    const store = new StateStore(root);

    const project: Project = {
      schema_version: SCHEMA_VERSION,
      id: "proj_demo",
      repo_root: "C:\\repo",
      name: "demo",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    await store.writeProject(project);
    expect(await store.readProject()).toEqual(project);

    const runId = generateId("run");
    const run: Run = {
      schema_version: SCHEMA_VERSION,
      id: runId,
      project_id: project.id,
      phase: "Inception",
      idea: "Build something",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    await store.writeRun(run);
    expect(await store.readRun(runId)).toEqual(run);

    const taskId = generateId("tsk");
    const task: Task = {
      id: taskId,
      run_id: runId,
      title: "First task",
      description: "Do the thing",
      status: "todo",
      origin: "plan",
      priority: 1,
      depends_on: [],
      role_affinity: ["backend"],
      scope: ["packages/core/**"],
      acceptance: ["typecheck"],
      review_criteria: ["lint"],
      workspace_mode: "worktree",
      attempt: 0,
      max_attempts: 3,
      artifacts: [],
      tier_override: "medium",
      adapter_override: "claude",
    };
    await store.writeTask(task);
    expect(await store.readTask(runId, taskId)).toEqual(task);
    expect(await store.listTasks(runId)).toEqual([task]);

    const gate: Gate = {
      id: generateId("gate"),
      type: "plan_approve",
      run_id: runId,
      status: "pending",
      created_at: "2026-01-01T00:00:00.000Z",
      payload: {},
    };
    await store.writeGates(runId, [gate]);
    expect(await store.readGates(runId)).toEqual([gate]);

    // atomic write leaves pretty JSON on disk
    const raw = await readFile(store.runPath(runId), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw).schema_version).toBe(SCHEMA_VERSION);
  });

  it("returns null/empty for missing entities", async () => {
    const root = await mkdtemp(join(tmpdir(), "lazyorch-state-empty-"));
    const store = new StateStore(root);
    expect(await store.readProject()).toBeNull();
    expect(await store.readRun("run_missing")).toBeNull();
    expect(await store.listTasks("run_missing")).toEqual([]);
    expect(await store.readGates("run_missing")).toEqual([]);
  });
});
