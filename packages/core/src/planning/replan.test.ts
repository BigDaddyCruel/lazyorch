import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../schema.js";
import type { Plan } from "../types/plan.js";
import type { Run } from "../types/run.js";
import type { Task } from "../types/task.js";
import {
  prepareReplan,
  ReplanError,
  resumeAfterReplan,
  supersedeOpenTasks,
} from "./replan.js";

function task(
  id: string,
  status: Task["status"],
): Task {
  return {
    id,
    run_id: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
    title: id,
    description: id,
    status,
    origin: "plan",
    priority: 2,
    depends_on: [],
    role_affinity: ["worker"],
    scope: ["src/**"],
    acceptance: ["ok"],
    review_criteria: [],
    workspace_mode: "worktree",
    attempt: 0,
    max_attempts: 3,
    artifacts: [],
  };
}

function run(phase: Run["phase"] = "Implementing"): Run {
  return {
    schema_version: SCHEMA_VERSION,
    id: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
    project_id: "proj",
    phase,
    idea: "idea",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    plan_id: "plan_old",
  };
}

const NEW_REV = "plan_cccccccccccccccccccccccc";

describe("supersedeOpenTasks", () => {
  it("cancels open tasks and preserves done", () => {
    const tasks = [
      task("t1", "done"),
      task("t2", "ready"),
      task("t3", "in_progress"),
      task("t4", "review"),
      task("t5", "todo"),
      task("t6", "blocked"),
      task("t7", "failed"),
      task("t8", "cancelled"),
    ];
    const result = supersedeOpenTasks(tasks, NEW_REV);
    expect(result.preserved_done_ids).toEqual(["t1"]);
    expect(result.already_cancelled_ids).toEqual(["t8"]);
    expect(result.cancelled_ids.sort()).toEqual(
      ["t2", "t3", "t4", "t5", "t6", "t7"].sort(),
    );
    for (const id of result.cancelled_ids) {
      const t = result.tasks.find((x) => x.id === id)!;
      expect(t.status).toBe("cancelled");
      expect(t.superseded_by_plan).toBe(NEW_REV);
    }
    expect(result.tasks.find((t) => t.id === "t1")?.status).toBe("done");
  });

  it("rejects empty plan revision id", () => {
    expect(() => supersedeOpenTasks([task("t1", "todo")], "")).toThrow(
      ReplanError,
    );
  });
});

describe("prepareReplan", () => {
  it("transitions Implementing → Planning and supersedes tasks", () => {
    const prior: Plan = {
      schema_version: SCHEMA_VERSION,
      id: "plan_old",
      run_id: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
      revision: 1,
      status: "frozen",
      issues: [],
      task_ids: ["t1", "t2"],
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      freeze_hash: "abc",
      frozen_at: "2026-01-01T00:00:00.000Z",
    };
    const tasks = [task("t1", "done"), task("t2", "ready")];
    const result = prepareReplan(
      run(),
      tasks,
      NEW_REV,
      { updated_at: "2026-03-01T00:00:00.000Z" },
      prior,
    );
    expect(result.run.phase).toBe("Planning");
    expect(result.cancelled_ids).toEqual(["t2"]);
    expect(result.preserved_done_ids).toEqual(["t1"]);
    expect(result.prior_plan?.status).toBe("superseded");
  });

  it("rejects non-Implementing phase", () => {
    expect(() =>
      prepareReplan(run("Planning"), [task("t1", "todo")], NEW_REV),
    ).toThrow(ReplanError);
  });

  it("rejects when integrating unless disabled", () => {
    expect(() =>
      prepareReplan(run(), [task("t1", "integrating")], NEW_REV),
    ).toThrow(ReplanError);

    const ok = prepareReplan(
      run(),
      [task("t1", "integrating")],
      NEW_REV,
      { reject_if_integrating: false },
    );
    expect(ok.cancelled_ids).toEqual(["t1"]);
    expect(ok.tasks[0]?.status).toBe("cancelled");
  });
});

describe("resumeAfterReplan", () => {
  it("PlanConsensus → Implementing", () => {
    const next = resumeAfterReplan(run("PlanConsensus"), {
      updated_at: "2026-03-02T00:00:00.000Z",
    });
    expect(next.phase).toBe("Implementing");
  });

  it("Planning → PlanConsensus → Implementing", () => {
    const next = resumeAfterReplan(run("Planning"));
    expect(next.phase).toBe("Implementing");
  });
});
