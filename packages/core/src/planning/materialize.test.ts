import { describe, expect, it } from "vitest";
import { computeFreezeHash, freezePayload } from "./materialize.js";
import { draftTask, validDesignMd } from "./test-fixtures.js";
import type { PlanArtifacts } from "./types.js";

describe("freeze hash stability", () => {
  it("is stable under task-list and field-array reordering", () => {
    const pr = "# PR Plan\n\n- tsk_a: implement\n- tsk_b: implement\n";
    const design = validDesignMd();

    const a: PlanArtifacts = {
      design_md: design,
      pr_plan_md: pr,
      task_dag: {
        tasks: [
          draftTask("tsk_b", {
            depends_on: ["tsk_a"],
            scope: ["b/**", "a/**"],
            acceptance: ["b", "a"],
            role_affinity: ["worker", "backend"],
          }),
          draftTask("tsk_a", {
            scope: ["a/**", "shared/**"],
            acceptance: ["x", "y"],
            role_affinity: ["backend", "worker"],
          }),
        ],
      },
    };

    const b: PlanArtifacts = {
      design_md: design,
      pr_plan_md: pr,
      task_dag: {
        tasks: [
          draftTask("tsk_a", {
            scope: ["shared/**", "a/**"],
            acceptance: ["y", "x"],
            role_affinity: ["worker", "backend"],
          }),
          draftTask("tsk_b", {
            depends_on: ["tsk_a"],
            scope: ["a/**", "b/**"],
            acceptance: ["a", "b"],
            role_affinity: ["backend", "worker"],
          }),
        ],
      },
    };

    expect(freezePayload(a, [])).toBe(freezePayload(b, []));
    expect(computeFreezeHash(a, [])).toBe(computeFreezeHash(b, []));
  });
});
