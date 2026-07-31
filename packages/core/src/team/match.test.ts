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

  it("matches design affinity [backend, worker] to backend-dev not fullstack", () => {
    const m = matchWorkerTemplate(["backend", "worker"], templates);
    expect(m.template_id).toBe("backend-dev");
    expect(m.used_fallback).toBe(false);
  });

  it("matches design affinity [frontend, worker] to frontend-dev not fullstack", () => {
    const m = matchWorkerTemplate(["frontend", "worker"], templates);
    expect(m.template_id).toBe("frontend-dev");
    expect(m.used_fallback).toBe(false);
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

  it("prefers specialized template over operator order when both match", () => {
    // fullstack listed first; only backend-dev has specialized "backend" tag
    const m = matchWorkerTemplate(["backend", "worker"], [
      "fullstack-dev",
      "backend-dev",
    ]);
    expect(m.template_id).toBe("backend-dev");
  });

  it("case-insensitive affinity matching", () => {
    const m = matchWorkerTemplate(["Backend"], templates);
    expect(m.template_id).toBe("backend-dev");
  });

  it("generic-only worker affinity selects fullstack when listed first", () => {
    const m = matchWorkerTemplate(["worker"], templates);
    expect(m.template_id).toBe("fullstack-dev");
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
      task("t_high", ["backend", "worker"], 1),
    ];
    const m = matchWorkerTemplateForReadyTasks(ready, [
      "fullstack-dev",
      "backend-dev",
      "frontend-dev",
    ]);
    expect(m.template_id).toBe("backend-dev");
  });
});
