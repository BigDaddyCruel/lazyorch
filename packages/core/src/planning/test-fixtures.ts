import type { PlanIssue } from "../types/plan.js";
import type { PlanArtifacts, PlanTaskDraft, PlanWriteResult } from "./types.js";

/** Minimal DESIGN.md with all required section headings. */
export function validDesignMd(extra = ""): string {
  return [
    "# Title & metadata",
    "",
    "## Overview",
    "Ship planning engine.",
    "",
    "## Background & motivation",
    "Need consensus.",
    "",
    "## Goals & non-goals",
    "Goals: freeze validators. Non-goals: real LLMs.",
    "",
    "## Proposed design",
    "Ports + validators + loop.",
    "",
    "## API / interface changes",
    "PlanWriterPort, PlanReviewerPort.",
    "",
    "## Data model changes",
    "Plan artifacts under .lazyorch/plans.",
    "",
    "## Alternatives considered",
    "1. Single-shot plan. 2. Multi-round consensus.",
    "",
    "## Security & privacy",
    "No secrets in plan artifacts.",
    "",
    "## Observability",
    "Round counts and freeze_hash.",
    "",
    "## Rollout / migration",
    "Feature flag later.",
    "",
    "## Open questions",
    "None.",
    "",
    "## Key Decisions",
    "| KD | Decision |",
    "|----|----------|",
    "| 1  | Fake ports |",
    "",
    "## PR Plan / Task DAG",
    "See TASK_DAG.json.",
    extra,
  ].join("\n");
}

export function draftTask(
  id: string,
  overrides: Partial<PlanTaskDraft> = {},
): PlanTaskDraft {
  return {
    id,
    title: `Task ${id}`,
    description: `Implement ${id}`,
    depends_on: [],
    role_affinity: ["worker"],
    scope: [`src/${id}/**`],
    acceptance: [`${id} tests pass`],
    review_criteria: ["typecheck"],
    ...overrides,
  };
}

export function validArtifacts(
  tasks: PlanTaskDraft[] = [draftTask("tsk_a"), draftTask("tsk_b", { depends_on: ["tsk_a"] })],
): PlanArtifacts {
  const ids = tasks.map((t) => t.id);
  return {
    design_md: validDesignMd(),
    task_dag: { tasks },
    pr_plan_md: [
      "# PR Plan",
      "",
      ...ids.map((id) => `- ${id}: implement`),
    ].join("\n"),
  };
}

export function writeResult(
  artifacts: PlanArtifacts = validArtifacts(),
  issue_updates?: PlanWriteResult["issue_updates"],
): PlanWriteResult {
  if (issue_updates !== undefined) {
    return { artifacts, issue_updates };
  }
  return { artifacts };
}

export function issue(
  overrides: Partial<PlanIssue> & Pick<PlanIssue, "id">,
): PlanIssue {
  const base: PlanIssue = {
    id: overrides.id,
    severity: "medium",
    category: "correctness",
    section: "Goals",
    description: "Something wrong",
    status: "open",
    raised_by: "agt_reviewer",
    raised_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
  return { ...base, ...overrides };
}
