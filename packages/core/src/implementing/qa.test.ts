import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../schema.js";
import type { Run } from "../types/run.js";
import type { Task } from "../types/task.js";
import {
  applyQaOutcome,
  applyQaPass,
  createDynamicFixTasks,
  needsRunLevelQa,
} from "./qa.js";

const FIXED = "2026-05-01T00:00:00.000Z";

function run(partial: Partial<Run> = {}): Run {
  return {
    schema_version: SCHEMA_VERSION,
    id: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
    project_id: "proj",
    phase: "Implementing",
    idea: "qa",
    created_at: FIXED,
    updated_at: FIXED,
    feature_tip_sha: "tip1",
    ...partial,
  };
}

function doneTask(id: string): Task {
  return {
    id,
    run_id: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
    title: id,
    description: "",
    status: "done",
    origin: "plan",
    priority: 2,
    depends_on: [],
    role_affinity: [],
    scope: [],
    acceptance: [],
    review_criteria: [],
    workspace_mode: "worktree",
    attempt: 1,
    max_attempts: 3,
    artifacts: [],
  };
}

describe("needsRunLevelQa", () => {
  it("true when tasks done and QA missing/stale", () => {
    expect(needsRunLevelQa(run(), [doneTask("tsk_a")])).toBe(true);
    expect(
      needsRunLevelQa(run({ qa: { passed_at_commit: "old" } }), [
        doneTask("tsk_a"),
      ]),
    ).toBe(true);
  });

  it("false when QA matches tip", () => {
    expect(
      needsRunLevelQa(run({ qa: { passed_at_commit: "tip1" } }), [
        doneTask("tsk_a"),
      ]),
    ).toBe(false);
  });

  it("false when open tasks remain", () => {
    const t = { ...doneTask("tsk_a"), status: "ready" as const };
    expect(needsRunLevelQa(run(), [t])).toBe(false);
  });
});

describe("applyQaOutcome", () => {
  it("records pass at tip", () => {
    const r = applyQaOutcome(run(), [doneTask("a")], { passed: true });
    expect(r.passed).toBe(true);
    expect(r.run.qa?.passed_at_commit).toBe("tip1");
    expect(r.fix_tasks).toHaveLength(0);
  });

  it("opens dynamic fix tasks on fail", () => {
    let n = 0;
    const r = applyQaOutcome(
      run(),
      [doneTask("a")],
      { passed: false, summary: "smoke broken" },
      {
        nextTaskId: () => {
          n += 1;
          return `tsk_${String(n).padStart(24, "b")}`;
        },
      },
    );
    expect(r.passed).toBe(false);
    expect(r.fix_tasks).toHaveLength(1);
    expect(r.fix_tasks[0]?.origin).toBe("dynamic");
    expect(r.fix_tasks[0]?.status).toBe("ready");
    expect(r.tasks).toHaveLength(2);
  });
});

describe("applyQaPass / createDynamicFixTasks", () => {
  it("applyQaPass sets tip", () => {
    const r = applyQaPass(run({ feature_tip_sha: "x" }), "y", () => FIXED);
    expect(r.qa?.passed_at_commit).toBe("y");
    expect(r.feature_tip_sha).toBe("y");
  });

  it("ci fix task includes failed checks", () => {
    const [t] = createDynamicFixTasks({
      run_id: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
      reason: "ci_fail",
      failed_checks: ["test", "lint"],
      summary: "CI red",
      nextTaskId: () => "tsk_cccccccccccccccccccccccc",
    });
    expect(t?.title).toContain("test");
    expect(t?.description).toContain("test");
    expect(t?.origin).toBe("dynamic");
  });
});
