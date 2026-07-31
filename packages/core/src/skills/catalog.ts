/**
 * Minimal v1 skill pack catalog (KD-23).
 * Skill ids match design table under packages/core/skills/.
 */

import type { AgentRole } from "../types/agent.js";

/** Built-in skill identifiers. */
export const BUILTIN_SKILL_IDS = [
  "careful",
  "freeze-scope",
  "review-checklist",
  "plan-writer",
  "plan-reviewer",
  "qa-runner",
] as const;

export type BuiltinSkillId = (typeof BUILTIN_SKILL_IDS)[number];

const SKILL_SET = new Set<string>(BUILTIN_SKILL_IDS);

export function isBuiltinSkillId(id: string): id is BuiltinSkillId {
  return SKILL_SET.has(id);
}

/** Default role → skill bindings (design Skills and shell safety). */
export const DEFAULT_ROLE_SKILLS: Readonly<Record<AgentRole, readonly string[]>> =
  {
    plan_writer: ["plan-writer", "careful"],
    plan_reviewer: ["plan-reviewer"],
    lead: ["careful", "freeze-scope"],
    worker: ["careful", "freeze-scope"],
    reviewer: ["review-checklist"],
    qa: ["qa-runner", "careful"],
  };

/**
 * Stub markdown bodies for each skill (v1 injection helpers).
 * Full prompts can grow later; stubs encode the contractual intent.
 */
export const SKILL_STUBS: Readonly<Record<BuiltinSkillId, string>> = {
  careful: `# Skill: careful

Refuse destructive git/fs operations unless an explicit gate has approved them.
Confirm before \`rm -rf\`, force-push, or rewriting history.
Never push credentials or secrets. Prefer reversible actions.
`,

  "freeze-scope": `# Skill: freeze-scope

Restrict edits to the task \`scope[]\` path globs.
Do not modify files outside scope. If scope is insufficient, report blocked and stop.
Do not expand scope without lead / replan.
`,

  "review-checklist": `# Skill: review-checklist

Produce a structured code review decision.

Write \`result.json\` in the session directory with shape:
\`\`\`json
{
  "kind": "review",
  "decision": "approve" | "reject",
  "comments": "optional free text"
}
\`\`\`

Check: correctness, scope adherence, tests/acceptance, security, and style consistency.
Reject when acceptance is unmet or scope is violated.
`,

  "plan-writer": `# Skill: plan-writer

Author the design document and task DAG for the planning phase.

Required design sections (headings): Summary, Goals, Non-Goals, Architecture, Tasks, Risks, PR Plan.
Emit TASK_DAG with non-empty role_affinity, scope, acceptance per task.
Respect max design size and context caps from config.
`,

  "plan-reviewer": `# Skill: plan-reviewer

Adversarial plan review checklist.

Challenge missing acceptance criteria, cycles in the DAG, vague scopes, and untestable goals.
File plan issues with severity and category. Approve only when residual risk is acceptable.
`,

  "qa-runner": `# Skill: qa-runner

Run task-local acceptance and run-level smoke checks.

Write \`result.json\` in the session directory with shape:
\`\`\`json
{
  "kind": "qa",
  "passed": true | false,
  "summary": "optional free text"
}
\`\`\`

Prefer allowlisted shell commands only. Do not use \`gh\` or network merge tools.
`,
};
