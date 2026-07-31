import { describe, expect, it } from "vitest";
import {
  canTransitionIssueStatus,
  countOpenIssues,
  PlanIssueError,
  transitionPlanIssue,
} from "./plan-issue.js";
import type { PlanIssue } from "./types/plan.js";

function issue(status: PlanIssue["status"], response?: string): PlanIssue {
  const base: PlanIssue = {
    id: "iss_1",
    severity: "medium",
    category: "correctness",
    section: "Goals",
    description: "Something wrong",
    status,
    raised_by: "agt_reviewer",
    raised_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
  if (response !== undefined) {
    return { ...base, response };
  }
  return base;
}

describe("PlanIssue status transitions", () => {
  it("allows open → addressed with response", () => {
    const next = transitionPlanIssue(issue("open"), "addressed", {
      response: "Fixed in r2",
      updated_at: "2026-01-02T00:00:00.000Z",
    });
    expect(next.status).toBe("addressed");
    expect(next.response).toBe("Fixed in r2");
    expect(next.updated_at).toBe("2026-01-02T00:00:00.000Z");
  });

  it("allows open → wontfix with response", () => {
    const next = transitionPlanIssue(issue("open"), "wontfix", {
      response: "Out of scope",
    });
    expect(next.status).toBe("wontfix");
  });

  it("allows open → needs-user-input", () => {
    const next = transitionPlanIssue(issue("open"), "needs-user-input");
    expect(next.status).toBe("needs-user-input");
  });

  it("allows needs-user-input → open", () => {
    const next = transitionPlanIssue(issue("needs-user-input"), "open");
    expect(next.status).toBe("open");
  });

  it("allows addressed → open (re-open)", () => {
    const next = transitionPlanIssue(
      issue("addressed", "done"),
      "open",
    );
    expect(next.status).toBe("open");
  });

  it("rejects addressed → wontfix", () => {
    expect(() =>
      transitionPlanIssue(issue("addressed", "x"), "wontfix"),
    ).toThrow(PlanIssueError);
    expect(canTransitionIssueStatus("addressed", "wontfix")).toBe(false);
  });

  it("requires response for addressed/wontfix", () => {
    expect(() => transitionPlanIssue(issue("open"), "addressed")).toThrow(
      PlanIssueError,
    );
    try {
      transitionPlanIssue(issue("open"), "addressed");
    } catch (e) {
      expect((e as PlanIssueError).code).toBe("response_required");
    }
  });

  it("same-status transition is a no-op edge", () => {
    expect(canTransitionIssueStatus("open", "open")).toBe(true);
    const next = transitionPlanIssue(issue("open"), "open", {
      updated_at: "2026-01-03T00:00:00.000Z",
    });
    expect(next.status).toBe("open");
  });
});

describe("countOpenIssues", () => {
  it("counts open and needs-user-input", () => {
    const issues = [
      issue("open"),
      issue("needs-user-input"),
      issue("addressed", "ok"),
      issue("wontfix", "nope"),
    ];
    expect(countOpenIssues(issues)).toBe(2);
  });
});
