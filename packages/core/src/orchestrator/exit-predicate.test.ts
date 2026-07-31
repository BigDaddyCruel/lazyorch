import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../schema.js";
import type { Run } from "../types/run.js";
import type { Task, TaskStatus } from "../types/task.js";
import {
  canExitImplementing,
  evaluatingImplementingExit,
} from "./exit-predicate.js";

function baseRun(overrides: Partial<Run> = {}): Run {
  return {
    schema_version: SCHEMA_VERSION,
    id: "run_1",
    project_id: "prj_1",
    phase: "Implementing",
    idea: "x",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    feature_tip_sha: "abc123",
    qa: { passed_at_commit: "abc123" },
    ...overrides,
  };
}

function t(
  id: string,
  status: TaskStatus,
  origin: Task["origin"] = "plan",
): Task {
  return {
    id,
    run_id: "run_1",
    title: id,
    description: "",
    status,
    origin,
    priority: 2,
    depends_on: [],
    role_affinity: [],
    scope: [],
    acceptance: ["ok"],
    review_criteria: [],
    workspace_mode: "worktree",
    attempt: 0,
    max_attempts: 3,
    artifacts: [],
  };
}

describe("Implementing exit predicate", () => {
  it("passes when all tasks done|cancelled and QA matches tip", () => {
    const run = baseRun();
    const tasks = [t("tsk_a", "done"), t("tsk_b", "cancelled")];
    const r = evaluatingImplementingExit(run, tasks);
    expect(r.ok).toBe(true);
    expect(r.qa_matches).toBe(true);
    expect(r.open_task_ids).toEqual([]);
    expect(canExitImplementing(run, tasks)).toBe(true);
  });

  it("fails when any open status remains", () => {
    for (const status of [
      "todo",
      "ready",
      "in_progress",
      "review",
      "integrating",
      "blocked",
      "failed",
    ] as const) {
      const r = evaluatingImplementingExit(baseRun(), [
        t("tsk_a", "done"),
        t("tsk_open", status, "dynamic"),
      ]);
      expect(r.ok).toBe(false);
      expect(r.open_task_ids).toContain("tsk_open");
    }
  });

  it("fails when QA tip does not match", () => {
    const run = baseRun({
      feature_tip_sha: "tip_new",
      qa: { passed_at_commit: "tip_old" },
    });
    const r = evaluatingImplementingExit(run, [t("tsk_a", "done")]);
    expect(r.ok).toBe(false);
    expect(r.qa_matches).toBe(false);
  });

  it("fails when QA missing", () => {
    const run = baseRun({ qa: undefined });
    const r = evaluatingImplementingExit(run, [t("tsk_a", "done")]);
    expect(r.ok).toBe(false);
  });

  it("fails when feature_tip_sha is missing or empty", () => {
    const missing = evaluatingImplementingExit(
      baseRun({ feature_tip_sha: undefined, qa: { passed_at_commit: "x" } }),
      [t("tsk_a", "done")],
    );
    expect(missing.ok).toBe(false);
    expect(missing.qa_matches).toBe(false);
    expect(missing.reasons.some((r) => r.includes("feature_tip_sha"))).toBe(
      true,
    );

    const empty = evaluatingImplementingExit(
      baseRun({ feature_tip_sha: "", qa: { passed_at_commit: "" } }),
      [t("tsk_a", "done")],
    );
    expect(empty.ok).toBe(false);
    expect(empty.reasons.some((r) => r.includes("feature_tip_sha"))).toBe(true);
  });

  it("passes with empty task list when QA matches tip", () => {
    const r = evaluatingImplementingExit(baseRun(), []);
    expect(r.ok).toBe(true);
    expect(r.open_task_ids).toEqual([]);
    expect(r.reasons).toEqual([]);
  });

  it("lists open task ids in reasons", () => {
    const r = evaluatingImplementingExit(baseRun(), [
      t("tsk_open", "blocked"),
      t("tsk_ok", "done"),
    ]);
    expect(r.ok).toBe(false);
    expect(r.open_task_ids).toEqual(["tsk_open"]);
    expect(r.reasons[0]).toContain("tsk_open");
  });

  it("accepts param overrides for tip / qa / skip", () => {
    const run = baseRun({
      feature_tip_sha: "a",
      qa: { passed_at_commit: "b" },
    });
    expect(
      canExitImplementing(run, [t("tsk_a", "done")], {
        feature_tip_sha: "x",
        qa_passed_at_commit: "x",
      }),
    ).toBe(true);
    expect(
      canExitImplementing(run, [t("tsk_a", "done")], { skip_qa_check: true }),
    ).toBe(true);
  });
});
