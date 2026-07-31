/**
 * Default role templates + preferred_adapters per role (PR-13).
 *
 * Skill bindings are sourced from `DEFAULT_ROLE_SKILLS` (single source of truth).
 */

import type { AgentRole } from "../types/agent.js";
import { DEFAULT_ROLE_SKILLS } from "../skills/catalog.js";
import type { RoleTemplate } from "./types.js";

/** Default coding-adapter preference (shell never a coding fallback). */
export const DEFAULT_CODING_PREFERRED_ADAPTERS: readonly string[] = [
  "claude",
  "codex",
  "grok",
  "agy",
] as const;

/** QA may prefer deterministic shell for acceptance/smoke jobs. */
export const DEFAULT_QA_PREFERRED_ADAPTERS: readonly string[] = [
  "shell",
  "claude",
  "codex",
] as const;

/** Per-role default preferred adapter lists. */
export const DEFAULT_PREFERRED_ADAPTERS_BY_ROLE: Readonly<
  Record<AgentRole, readonly string[]>
> = {
  lead: DEFAULT_CODING_PREFERRED_ADAPTERS,
  worker: DEFAULT_CODING_PREFERRED_ADAPTERS,
  reviewer: DEFAULT_CODING_PREFERRED_ADAPTERS,
  plan_writer: DEFAULT_CODING_PREFERRED_ADAPTERS,
  plan_reviewer: DEFAULT_CODING_PREFERRED_ADAPTERS,
  qa: DEFAULT_QA_PREFERRED_ADAPTERS,
};

/** Fallback worker template when role_affinity ∩ templates is empty. */
export const FALLBACK_WORKER_TEMPLATE = "fullstack-dev";

/**
 * Built-in role templates.
 * Config `team.lead_template` / `worker_templates` / etc. reference these ids.
 * Skills always come from DEFAULT_ROLE_SKILLS (catalog) via skillsForRoleDefault.
 */
export const DEFAULT_ROLE_TEMPLATES: readonly RoleTemplate[] = [
  {
    id: "architect-lead",
    role: "lead",
    labels: ["architect-lead", "lead", "architect"],
    preferred_adapters: [...DEFAULT_CODING_PREFERRED_ADAPTERS],
    skills: [...DEFAULT_ROLE_SKILLS.lead],
    default_tier: "medium",
    session_kind: "llm",
    approval_policy: "suggest",
    description:
      "Execution ownership, assign policy, escalate, conflict decisions",
  },
  {
    id: "fullstack-dev",
    role: "worker",
    // Intentionally does NOT claim backend/frontend tags so specialized
    // templates win affinity matches; fullstack remains the empty-match fallback.
    labels: ["fullstack-dev", "fullstack", "worker"],
    preferred_adapters: [...DEFAULT_CODING_PREFERRED_ADAPTERS],
    skills: [...DEFAULT_ROLE_SKILLS.worker],
    default_tier: "small",
    session_kind: "llm",
    approval_policy: "auto",
    description: "General implementer (default worker fallback)",
  },
  {
    id: "backend-dev",
    role: "worker",
    labels: ["backend-dev", "backend", "worker", "api", "server"],
    preferred_adapters: [...DEFAULT_CODING_PREFERRED_ADAPTERS],
    skills: [...DEFAULT_ROLE_SKILLS.worker],
    default_tier: "small",
    session_kind: "llm",
    approval_policy: "auto",
    description: "Backend-focused implementer",
  },
  {
    id: "frontend-dev",
    role: "worker",
    labels: ["frontend-dev", "frontend", "worker", "ui", "web"],
    preferred_adapters: [...DEFAULT_CODING_PREFERRED_ADAPTERS],
    skills: [...DEFAULT_ROLE_SKILLS.worker],
    default_tier: "small",
    session_kind: "llm",
    approval_policy: "auto",
    description: "Frontend-focused implementer",
  },
  {
    id: "code-reviewer",
    role: "reviewer",
    labels: ["code-reviewer", "reviewer", "review"],
    preferred_adapters: [...DEFAULT_CODING_PREFERRED_ADAPTERS],
    skills: [...DEFAULT_ROLE_SKILLS.reviewer],
    default_tier: "medium",
    session_kind: "llm",
    approval_policy: "auto",
    description: "Code review; approve/reject (no product code push)",
  },
  {
    id: "qa-engineer",
    role: "qa",
    labels: ["qa-engineer", "qa", "test", "smoke"],
    preferred_adapters: [...DEFAULT_QA_PREFERRED_ADAPTERS],
    skills: [...DEFAULT_ROLE_SKILLS.qa],
    default_tier: "small",
    session_kind: "deterministic",
    approval_policy: "auto",
    description: "Task-local + run-level tests/smoke",
  },
  {
    id: "plan-writer",
    role: "plan_writer",
    labels: ["plan-writer", "plan_writer", "writer"],
    preferred_adapters: [...DEFAULT_CODING_PREFERRED_ADAPTERS],
    skills: [...DEFAULT_ROLE_SKILLS.plan_writer],
    default_tier: "large",
    session_kind: "llm",
    approval_policy: "auto",
    description: "Author plan during Planning",
  },
  {
    id: "plan-reviewer",
    role: "plan_reviewer",
    labels: ["plan-reviewer", "plan_reviewer", "plan-review"],
    preferred_adapters: [...DEFAULT_CODING_PREFERRED_ADAPTERS],
    skills: [...DEFAULT_ROLE_SKILLS.plan_reviewer],
    default_tier: "large",
    session_kind: "llm",
    approval_policy: "auto",
    description: "Adversarial plan critique",
  },
] as const;

const TEMPLATE_BY_ID = new Map(
  DEFAULT_ROLE_TEMPLATES.map((t) => [t.id, t] as const),
);

/** Deep-enough clone so callers cannot mutate the shared catalog arrays. */
export function cloneRoleTemplate(t: RoleTemplate): RoleTemplate {
  const out: RoleTemplate = {
    id: t.id,
    role: t.role,
    labels: [...t.labels],
    preferred_adapters: [...t.preferred_adapters],
    skills: [...t.skills],
    session_kind: t.session_kind,
    approval_policy: t.approval_policy,
  };
  if (t.default_tier !== undefined) out.default_tier = t.default_tier;
  if (t.description !== undefined) out.description = t.description;
  return out;
}

/**
 * Lookup built-in template by id (cloned; never returns shared catalog arrays).
 */
export function getRoleTemplate(id: string): RoleTemplate | undefined {
  const known = TEMPLATE_BY_ID.get(id);
  return known ? cloneRoleTemplate(known) : undefined;
}

/** All built-in template ids. */
export function listRoleTemplateIds(): string[] {
  return DEFAULT_ROLE_TEMPLATES.map((t) => t.id);
}

/** Preferred adapters for a role (config override → defaults). */
export function preferredAdaptersForRole(
  role: AgentRole,
  override?: Partial<Record<AgentRole, readonly string[]>>,
): string[] {
  const fromOverride = override?.[role];
  if (fromOverride && fromOverride.length > 0) {
    return [...fromOverride];
  }
  return [
    ...(DEFAULT_PREFERRED_ADAPTERS_BY_ROLE[role] ??
      DEFAULT_CODING_PREFERRED_ADAPTERS),
  ];
}

/**
 * Resolve a RoleTemplate by id, or synthesize a minimal one for an unknown id
 * with the given role (keeps operator custom template names usable).
 * Always returns a fresh clone (catalog arrays are never shared).
 */
export function resolveRoleTemplate(
  id: string,
  role: AgentRole,
  preferredOverride?: Partial<Record<AgentRole, readonly string[]>>,
): RoleTemplate {
  const known = TEMPLATE_BY_ID.get(id);
  if (known) {
    const cloned = cloneRoleTemplate(known);
    if (preferredOverride?.[role]) {
      cloned.preferred_adapters = preferredAdaptersForRole(
        role,
        preferredOverride,
      );
    }
    return cloned;
  }
  return {
    id,
    role,
    labels: [id, role],
    preferred_adapters: preferredAdaptersForRole(role, preferredOverride),
    skills: skillsForRoleDefault(role),
    session_kind: role === "qa" ? "deterministic" : "llm",
    approval_policy: role === "lead" ? "suggest" : "auto",
  };
}

/**
 * Default skill binding for a role — single source: DEFAULT_ROLE_SKILLS.
 */
export function skillsForRoleDefault(role: AgentRole): string[] {
  return [...(DEFAULT_ROLE_SKILLS[role] ?? ["careful"])];
}

/** Default template id for a role when config omits it. */
export function defaultTemplateIdForRole(role: AgentRole): string {
  switch (role) {
    case "lead":
      return "architect-lead";
    case "worker":
      return FALLBACK_WORKER_TEMPLATE;
    case "reviewer":
      return "code-reviewer";
    case "qa":
      return "qa-engineer";
    case "plan_writer":
      return "plan-writer";
    case "plan_reviewer":
      return "plan-reviewer";
    default:
      return FALLBACK_WORKER_TEMPLATE;
  }
}
