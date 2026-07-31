import { describe, expect, it } from "vitest";
import {
  mayCollapsePlanWriterAndReviewer,
  resolveTeamMode,
  soloForcesTaskApprove,
} from "./mode.js";

describe("resolveTeamMode", () => {
  it("full mode preserves workers/reviewers/qa and default gates", () => {
    const limits = resolveTeamMode({
      mode: "full",
      min_workers: 0,
      max_workers: 4,
      min_reviewers: 1,
      max_reviewers: 2,
      min_qa: 1,
      max_qa: 2,
    });
    expect(limits.mode).toBe("full");
    expect(limits.max_workers).toBe(4);
    expect(limits.min_reviewers).toBe(1);
    expect(limits.max_reviewers).toBe(2);
    expect(limits.min_qa).toBe(1);
    expect(limits.max_qa).toBe(2);
    expect(limits.gates.task_approve).toBe(false);
    expect(limits.gates.plan_approve).toBe(true);
    expect(limits.gates.merge).toBe(true);
    expect(limits.allow_plan_writer_eq_reviewer).toBe(false);
  });

  it("solo forces zero workers/reviewers/qa and compensating gates (KD-25)", () => {
    const limits = resolveTeamMode({
      mode: "solo",
      max_workers: 4,
      min_reviewers: 1,
      max_reviewers: 2,
      min_qa: 1,
      max_qa: 2,
      gates: {
        task_approve: false,
        plan_approve: false,
        merge: false,
      },
    });
    expect(limits.mode).toBe("solo");
    expect(limits.min_workers).toBe(0);
    expect(limits.max_workers).toBe(0);
    expect(limits.min_reviewers).toBe(0);
    expect(limits.max_reviewers).toBe(0);
    expect(limits.min_qa).toBe(0);
    expect(limits.max_qa).toBe(0);
    expect(limits.gates).toEqual({
      task_approve: true,
      plan_approve: true,
      merge: true,
    });
    expect(limits.allow_plan_writer_eq_reviewer).toBe(true);
  });

  it("soloForcesTaskApprove / mayCollapsePlanWriterAndReviewer helpers", () => {
    expect(soloForcesTaskApprove("solo")).toBe(true);
    expect(soloForcesTaskApprove("full")).toBe(false);
    expect(mayCollapsePlanWriterAndReviewer("solo")).toBe(true);
    expect(mayCollapsePlanWriterAndReviewer("full")).toBe(false);
  });
});
