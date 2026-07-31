import { describe, expect, it } from "vitest";
import {
  draftTask,
  issue,
  validArtifacts,
  validDesignMd,
} from "./test-fixtures.js";
import type { PlanTaskDraft } from "./types.js";
import {
  DEFAULT_REQUIRED_SECTIONS,
  extractHeadings,
  headingMatches,
  textReferencesTaskId,
  validateDesignSections,
  validateDesignSize,
  validateFreeze,
  validatePrPlanCoverage,
  validateScopeOverlaps,
  validateTaskDag,
} from "./validators.js";

describe("extractHeadings / headingMatches", () => {
  it("extracts ATX headings", () => {
    const h = extractHeadings("# Title\n\n## Goals & non-goals\n");
    expect(h).toEqual(["Title", "Goals & non-goals"]);
  });

  it("matches case-insensitively by heading contains required", () => {
    expect(headingMatches(["Goals & Non-Goals"], "goals")).toBe(true);
    expect(headingMatches(["Security & privacy"], "Security")).toBe(true);
    expect(headingMatches(["Overview"], "Missing")).toBe(false);
  });

  it("does not let short headings satisfy longer required sections", () => {
    expect(headingMatches(["S"], "Security")).toBe(false);
    expect(headingMatches(["a"], "Background")).toBe(false);
    expect(headingMatches(["API / interface changes"], "API")).toBe(true);
  });
});

describe("validateTaskDag", () => {
  it("accepts a simple DAG with required fields", () => {
    const errors = validateTaskDag({
      tasks: [draftTask("a"), draftTask("b", { depends_on: ["a"] })],
    });
    expect(errors).toEqual([]);
  });

  it("rejects empty dag", () => {
    expect(validateTaskDag({ tasks: [] })[0]?.code).toBe("empty_dag");
  });

  it("rejects missing tasks array without throwing", () => {
    const errors = validateTaskDag({} as { tasks: PlanTaskDraft[] });
    expect(errors[0]?.code).toBe("empty_dag");
  });

  it("rejects cycles", () => {
    const errors = validateTaskDag({
      tasks: [
        draftTask("a", { depends_on: ["b"] }),
        draftTask("b", { depends_on: ["a"] }),
      ],
    });
    expect(errors.some((e) => e.code === "cycle")).toBe(true);
  });

  it("rejects missing depends_on targets", () => {
    const errors = validateTaskDag({
      tasks: [draftTask("a", { depends_on: ["missing"] })],
    });
    expect(errors.some((e) => e.code === "missing_dep")).toBe(true);
  });

  it("rejects non-array depends_on without throwing", () => {
    const bad = draftTask("a");
    // Simulate malformed LLM JSON
    (bad as { depends_on: unknown }).depends_on = "not-an-array";
    const errors = validateTaskDag({ tasks: [bad] });
    expect(errors.some((e) => e.code === "invalid_depends_on")).toBe(true);
  });

  it("treats missing depends_on as empty array", () => {
    const t = draftTask("a");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (t as any).depends_on;
    const errors = validateTaskDag({ tasks: [t] });
    expect(errors.some((e) => e.code === "invalid_depends_on")).toBe(false);
    expect(errors.some((e) => e.code === "cycle")).toBe(false);
  });

  it("rejects empty title/acceptance/scope/role_affinity", () => {
    const errors = validateTaskDag({
      tasks: [
        draftTask("a", {
          title: "  ",
          acceptance: [],
          scope: [],
          role_affinity: [],
          description: "",
        }),
      ],
    });
    const codes = new Set(errors.map((e) => e.code));
    expect(codes.has("empty_title")).toBe(true);
    expect(codes.has("empty_acceptance")).toBe(true);
    expect(codes.has("empty_scope")).toBe(true);
    expect(codes.has("empty_role_affinity")).toBe(true);
    expect(codes.has("empty_description")).toBe(true);
  });

  it("rejects empty / whitespace ids", () => {
    const errors = validateTaskDag({
      tasks: [draftTask("  ", { title: "x", description: "y" })],
    });
    expect(errors.some((e) => e.code === "empty_id")).toBe(true);
  });

  it("rejects duplicate ids", () => {
    const errors = validateTaskDag({
      tasks: [draftTask("a"), draftTask("a")],
    });
    expect(errors.some((e) => e.code === "duplicate_id")).toBe(true);
  });
});

describe("validateDesignSections", () => {
  it("passes valid design", () => {
    expect(validateDesignSections(validDesignMd())).toEqual([]);
  });

  it("fails when a required section is missing", () => {
    const md = "# Title\n## Overview\n";
    const errors = validateDesignSections(md, ["Title", "Security"]);
    expect(errors.some((e) => e.code === "missing_section")).toBe(true);
    expect(errors.find((e) => e.path === "Security")).toBeDefined();
  });

  it("exposes default required sections", () => {
    expect(DEFAULT_REQUIRED_SECTIONS.length).toBeGreaterThanOrEqual(10);
  });
});

describe("validateDesignSize", () => {
  it("rejects oversized design", () => {
    const errors = validateDesignSize("hello", 3);
    expect(errors[0]?.code).toBe("design_too_large");
  });
});

describe("validatePrPlanCoverage / textReferencesTaskId", () => {
  it("requires every task id in PR_PLAN", () => {
    const errors = validatePrPlanCoverage("covers tsk_a only", [
      "tsk_a",
      "tsk_b",
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("tsk_b");
  });

  it("uses token boundaries (tsk_1 not covered by tsk_10)", () => {
    expect(textReferencesTaskId("plan for tsk_10 only", "tsk_1")).toBe(false);
    expect(textReferencesTaskId("plan for tsk_10 only", "tsk_10")).toBe(true);
    expect(textReferencesTaskId("- tsk_a: work", "tsk_a")).toBe(true);
  });

  it("rejects empty task ids", () => {
    const errors = validatePrPlanCoverage("anything", [""]);
    expect(errors[0]?.code).toBe("pr_plan_coverage");
  });
});

describe("validateScopeOverlaps", () => {
  it("errors on undeclared exact scope overlap when strict", () => {
    const errors = validateScopeOverlaps(
      {
        tasks: [
          draftTask("a", { scope: ["src/shared/**"] }),
          draftTask("b", { scope: ["src/shared/**"] }),
        ],
      },
      true,
    );
    expect(errors.some((e) => e.code === "scope_overlap")).toBe(true);
  });

  it("allows declared overlaps", () => {
    const errors = validateScopeOverlaps(
      {
        tasks: [
          draftTask("a", { scope: ["src/shared/**"] }),
          draftTask("b", { scope: ["src/shared/**"] }),
        ],
        meta: {
          overlapping_scopes: [
            { task_ids: ["a", "b"], paths: ["src/shared/**"] },
          ],
        },
      },
      true,
    );
    expect(errors).toEqual([]);
  });

  it("skips when strict_scopes false", () => {
    const errors = validateScopeOverlaps(
      {
        tasks: [
          draftTask("a", { scope: ["x"] }),
          draftTask("b", { scope: ["x"] }),
        ],
      },
      false,
    );
    expect(errors).toEqual([]);
  });
});

describe("validateFreeze", () => {
  it("passes clean artifacts with no open issues", () => {
    const result = validateFreeze({
      artifacts: validArtifacts(),
      issues: [],
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("fails when open issues remain", () => {
    const result = validateFreeze({
      artifacts: validArtifacts(),
      issues: [issue({ id: "iss_1", status: "open" })],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === "open_issues")).toBe(true);
  });

  it("counts needs-user-input as blocking", () => {
    const result = validateFreeze({
      artifacts: validArtifacts(),
      issues: [issue({ id: "iss_1", status: "needs-user-input" })],
    });
    expect(result.ok).toBe(false);
  });

  it("allows addressed / wontfix issues", () => {
    const result = validateFreeze({
      artifacts: validArtifacts(),
      issues: [
        issue({ id: "iss_1", status: "addressed", response: "fixed" }),
        issue({ id: "iss_2", status: "wontfix", response: "nope" }),
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("does not throw when task_dag.tasks is missing", () => {
    const artifacts = validArtifacts();
    // @ts-expect-error intentional malformed
    artifacts.task_dag = {};
    const result = validateFreeze({ artifacts, issues: [] });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === "empty_dag")).toBe(true);
  });
});
