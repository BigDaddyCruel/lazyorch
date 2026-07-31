import { describe, expect, it } from "vitest";
import type { Task } from "../types/task.js";
import {
  affinityIntersection,
  matchWorkerTemplate,
  matchWorkerTemplateForReadyTasks,
} from "./match.js";
import { FALLBACK_WORKER_TEMPLATE, getRoleTemplate } from "./role-templates.js";

function task(
  id: string,
  affinity: string[],
  priority: 1 | 2 | 3 | 4 = 2,
): Task {
  return {
    id,
    run_id: "run_1",
    title: id,
    description: "",
    status: "ready",
    origin: "plan",
    priority,
    depends_on: [],
    role_affinity: affinity,
    scope: [],
    acceptance: [],
    review_criteria: [],
    workspace_mode: "worktree",
    attempt: 1,
    max_attempts: 3,
    artifacts: [],
  };
}

describe("matchWorkerTemplate", () => {
  const templates = ["fullstack-dev", "backend-dev", "frontend-dev"];

  it("matches backend affinity to backend-dev", () => {
    const m = matchWorkerTemplate(["backend", "api"], templates);
    expect(m.template_id).toBe("backend-dev");
    expect(m.used_fallback).toBe(false);
    expect(m.matched_tags.map((t) => t.toLowerCase())).toContain("backend");
  });

  it("matches frontend affinity to frontend-dev", () => {
    const m = matchWorkerTemplate(["frontend-dev"], templates);
    expect(m.template_id).toBe("frontend-dev");
    expect(m.used_fallback).toBe(false);
  });

  it("falls back to fullstack-dev when no affinity matches", () => {
    const m = matchWorkerTemplate(["mobile-only"], templates);
    expect(m.template_id).toBe(FALLBACK_WORKER_TEMPLATE);
    expect(m.used_fallback).toBe(true);
    expect(m.matched_tags).toEqual([]);
  });

  it("prefers operator-ordered template when multiple match", () => {
    // fullstack labels include backend+frontend; backend-dev also matches backend
    const m = matchWorkerTemplate(["backend"], [
      "backend-dev",
      "fullstack-dev",
    ]);
    expect(m.template_id).toBe("backend-dev");
  });

  it("case-insensitive affinity matching", () => {
    const m = matchWorkerTemplate(["Backend"], templates);
    expect(m.template_id).toBe("backend-dev");
  });
});

describe("affinityIntersection", () => {
  it("returns overlapping tags", () => {
    const tpl = getRoleTemplate("backend-dev")!;
    expect(affinityIntersection(["backend", "docs"], tpl)).toEqual(["backend"]);
  });
});

describe("matchWorkerTemplateForReadyTasks", () => {
  it("uses highest-priority ready task for multi-template choice", () => {
    const ready = [
      task("t_low", ["frontend"], 3),
      task("t_high", ["backend"], 1),
    ];
    const m = matchWorkerTemplateForReadyTasks(ready, [
      "fullstack-dev",
      "backend-dev",
      "frontend-dev",
    ]);
    expect(m.template_id).toBe("backend-dev");
  });
});
