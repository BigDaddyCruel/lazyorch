import { describe, expect, it } from "vitest";
import type { Run, RunPhase } from "../types/run.js";
import { SCHEMA_VERSION } from "../schema.js";
import type { Task } from "../types/task.js";
import {
  allowedRunTransitions,
  canTransitionRunPhase,
  exitImplementing,
  hasReadyPr,
  isTerminalPhase,
  nextPhaseAfterImplementingExit,
  RunFsmError,
  transitionRunPhase,
} from "./run-fsm.js";


function run(phase: RunPhase): Run {
  return {
    schema_version: SCHEMA_VERSION,
    id: "run_test",
    project_id: "prj_test",
    phase,
    idea: "ship it",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

describe("run FSM", () => {
  it("allows the main happy path", () => {
    const path: RunPhase[] = [
      "Inception",
      "Planning",
      "PlanConsensus",
      "Implementing",
      "PrePR",
      "PROpen",
      "CILoop",
      "MergeReady",
      "Merged",
    ];
    let r = run("Inception");
    for (let i = 1; i < path.length; i++) {
      expect(canTransitionRunPhase(path[i - 1]!, path[i]!)).toBe(true);
      r = transitionRunPhase(r, path[i]!, {
        updated_at: `2026-01-0${Math.min(i + 1, 9)}T00:00:00.000Z`,
      });
      expect(r.phase).toBe(path[i]);
    }
    expect(isTerminalPhase(r.phase)).toBe(true);
  });

  it("allows Implementing → CILoop when ready PR exists (edge legal)", () => {
    expect(canTransitionRunPhase("Implementing", "CILoop")).toBe(true);
    const next = transitionRunPhase(run("Implementing"), "CILoop");
    expect(next.phase).toBe("CILoop");
  });

  it("allows CILoop → Implementing for CI fix tasks", () => {
    expect(canTransitionRunPhase("CILoop", "Implementing")).toBe(true);
  });

  it("allows MergeReady → Implementing for changes requested", () => {
    expect(canTransitionRunPhase("MergeReady", "Implementing")).toBe(true);
  });

  it("allows Planning self-edge for revise rounds", () => {
    expect(canTransitionRunPhase("Planning", "Planning")).toBe(true);
    expect(transitionRunPhase(run("Planning"), "Planning").phase).toBe(
      "Planning",
    );
  });

  it("allows PlanConsensus → Planning (plan_approve revise) and → Implementing", () => {
    expect(canTransitionRunPhase("PlanConsensus", "Planning")).toBe(true);
    expect(canTransitionRunPhase("PlanConsensus", "Implementing")).toBe(true);
    expect(transitionRunPhase(run("PlanConsensus"), "Planning").phase).toBe(
      "Planning",
    );
    expect(transitionRunPhase(run("PlanConsensus"), "Implementing").phase).toBe(
      "Implementing",
    );
    expect(transitionRunPhase(run("PlanConsensus"), "Cancelled").phase).toBe(
      "Cancelled",
    );
  });

  it("allows Implementing → Planning for mid-run replan", () => {
    expect(canTransitionRunPhase("Implementing", "Planning")).toBe(true);
    expect(transitionRunPhase(run("Implementing"), "Planning").phase).toBe(
      "Planning",
    );
  });

  it("rejects illegal edges", () => {
    expect(canTransitionRunPhase("Inception", "Merged")).toBe(false);
    expect(canTransitionRunPhase("Implementing", "PlanConsensus")).toBe(false);
    expect(canTransitionRunPhase("Merged", "Implementing")).toBe(false);
    expect(() => transitionRunPhase(run("Inception"), "Merged")).toThrow(
      RunFsmError,
    );
    try {
      transitionRunPhase(run("Merged"), "Planning");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(RunFsmError);
      expect((e as RunFsmError).code).toBe("terminal");
    }
  });

  it("exitImplementing composes predicate + PrePR/CILoop routing", () => {
    const done: Task = {
      id: "tsk_a",
      run_id: "run_test",
      title: "a",
      description: "",
      status: "done",
      origin: "plan",
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
    const base = {
      ...run("Implementing"),
      feature_tip_sha: "tip",
      qa: { passed_at_commit: "tip" },
    };
    expect(exitImplementing(base, [done]).phase).toBe("PrePR");
    expect(
      exitImplementing(
        { ...base, pr_ref: { number: 1, state: "ready" } },
        [done],
      ).phase,
    ).toBe("CILoop");
    try {
      exitImplementing(base, [{ ...done, status: "ready" }]);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(RunFsmError);
      expect((e as RunFsmError).code).toBe("exit_not_ready");
    }
  });

  it("records cancel/fail reasons", () => {
    const c = transitionRunPhase(run("Implementing"), "Cancelled", {
      cancelled_reason: "user abort",
    });
    expect(c.cancelled_reason).toBe("user abort");
    const f = transitionRunPhase(run("Planning"), "Failed", {
      failed_reason: "planner crash",
    });
    expect(f.failed_reason).toBe("planner crash");
  });

  it("lists allowed transitions", () => {
    expect(allowedRunTransitions("Implementing")).toEqual(
      expect.arrayContaining([
        "PrePR",
        "CILoop",
        "Planning",
        "Cancelled",
        "Failed",
      ]),
    );
    expect(allowedRunTransitions("Merged")).toEqual([]);
  });

  it("nextPhaseAfterImplementingExit respects ready PR", () => {
    expect(nextPhaseAfterImplementingExit(undefined)).toBe("PrePR");
    expect(
      nextPhaseAfterImplementingExit({ number: 1, state: "draft" }),
    ).toBe("PrePR");
    expect(
      nextPhaseAfterImplementingExit({ number: 2, state: "ready" }),
    ).toBe("CILoop");
    expect(hasReadyPr({ number: 2, state: "ready" })).toBe(true);
    expect(hasReadyPr({ number: 1, state: "draft" })).toBe(false);
  });
});
