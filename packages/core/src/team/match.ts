/**
 * Role-template matching for scheduler assign (PR-13).
 *
 * On spawn / mint worker:
 * 1. Intersection of ready task role_affinity with template tags
 * 2. If multiple templates match, prefer specialized (non-generic) tags first,
 *    then more matched tags, then operator worker_templates order
 * 3. If none match, use fullstack-dev fallback
 */

import type { Task } from "../types/task.js";
import {
  FALLBACK_WORKER_TEMPLATE,
  getRoleTemplate,
  resolveRoleTemplate,
} from "./role-templates.js";
import type { RoleTemplate } from "./types.js";

export interface MatchWorkerTemplateResult {
  template_id: string;
  template: RoleTemplate;
  /** Tags from role_affinity that matched template labels (or id). */
  matched_tags: string[];
  /** True when no affinity matched and fullstack-dev (or first configured) was used. */
  used_fallback: boolean;
}

/**
 * Generic affinity tags that do not distinguish specialized worker templates.
 * When multi-matching, specialized (non-generic) overlaps win over generic-only.
 */
export const GENERIC_WORKER_TAGS: ReadonlySet<string> = new Set([
  "worker",
  "fullstack",
  "fullstack-dev",
]);

function normalizeTag(s: string): string {
  return s.trim().toLowerCase();
}

/** Build label/id set for a template (id + labels, normalized). */
export function templateTagSet(template: RoleTemplate): Set<string> {
  const set = new Set<string>();
  set.add(normalizeTag(template.id));
  for (const l of template.labels) {
    set.add(normalizeTag(l));
  }
  return set;
}

/**
 * Intersection of role_affinity tags with a template's labels/id.
 * Matching is case-insensitive.
 */
export function affinityIntersection(
  roleAffinity: readonly string[],
  template: RoleTemplate,
): string[] {
  const tags = templateTagSet(template);
  const matched: string[] = [];
  const seen = new Set<string>();
  for (const raw of roleAffinity) {
    const n = normalizeTag(raw);
    if (!n || seen.has(n)) continue;
    if (tags.has(n)) {
      seen.add(n);
      matched.push(raw);
    }
  }
  return matched;
}

/** Count matched tags that are not generic (backend, frontend, api, …). */
export function specializedMatchCount(matchedTags: readonly string[]): number {
  let n = 0;
  for (const t of matchedTags) {
    if (!GENERIC_WORKER_TAGS.has(normalizeTag(t))) n += 1;
  }
  return n;
}

/**
 * Pick worker template for a single task's role_affinity.
 *
 * @param roleAffinity - task.role_affinity
 * @param workerTemplates - config team.worker_templates (tie-break among equal specificity)
 * @param catalog - optional extra templates (defaults to built-ins + synthetic for unknown ids)
 */
export function matchWorkerTemplate(
  roleAffinity: readonly string[],
  workerTemplates: readonly string[] = [FALLBACK_WORKER_TEMPLATE],
  catalog?: readonly RoleTemplate[],
): MatchWorkerTemplateResult {
  const templates = resolveWorkerTemplateList(workerTemplates, catalog);

  const matches: { template: RoleTemplate; matched_tags: string[] }[] = [];
  for (const t of templates) {
    const matched = affinityIntersection(roleAffinity, t);
    if (matched.length > 0) {
      matches.push({ template: t, matched_tags: matched });
    }
  }

  if (matches.length === 1) {
    const m = matches[0]!;
    return {
      template_id: m.template.id,
      template: m.template,
      matched_tags: m.matched_tags,
      used_fallback: false,
    };
  }

  if (matches.length > 1) {
    // Prefer specialized tag overlap before operator order so design affinities
    // like ["backend", "worker"] select backend-dev over fullstack-dev.
    const order = new Map(workerTemplates.map((id, i) => [id, i]));
    matches.sort((a, b) => {
      const sa = specializedMatchCount(a.matched_tags);
      const sb = specializedMatchCount(b.matched_tags);
      if (sb !== sa) return sb - sa;
      // Then more total matched tags
      if (b.matched_tags.length !== a.matched_tags.length) {
        return b.matched_tags.length - a.matched_tags.length;
      }
      // Then operator worker_templates order
      const ia = order.get(a.template.id) ?? Number.MAX_SAFE_INTEGER;
      const ib = order.get(b.template.id) ?? Number.MAX_SAFE_INTEGER;
      if (ia !== ib) return ia - ib;
      return a.template.id.localeCompare(b.template.id);
    });
    const m = matches[0]!;
    return {
      template_id: m.template.id,
      template: m.template,
      matched_tags: m.matched_tags,
      used_fallback: false,
    };
  }

  // Fallback
  const fallbackId = workerTemplates.includes(FALLBACK_WORKER_TEMPLATE)
    ? FALLBACK_WORKER_TEMPLATE
    : (workerTemplates[0] ?? FALLBACK_WORKER_TEMPLATE);
  const fallback =
    templates.find((t) => t.id === fallbackId) ??
    resolveRoleTemplate(fallbackId, "worker");
  return {
    template_id: fallback.id,
    template: fallback,
    matched_tags: [],
    used_fallback: true,
  };
}

/**
 * When multiple ready tasks compete for spawn, pick the template matching the
 * highest-priority ready task (priority 1 best).
 */
export function matchWorkerTemplateForReadyTasks(
  readyTasks: readonly Task[],
  workerTemplates: readonly string[] = [FALLBACK_WORKER_TEMPLATE],
  catalog?: readonly RoleTemplate[],
): MatchWorkerTemplateResult {
  if (readyTasks.length === 0) {
    return matchWorkerTemplate([], workerTemplates, catalog);
  }
  // Highest priority first (1 = highest), then stable by id
  const sorted = [...readyTasks].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const top = sorted[0]!;
  return matchWorkerTemplate(top.role_affinity, workerTemplates, catalog);
}

function resolveWorkerTemplateList(
  workerTemplates: readonly string[],
  catalog?: readonly RoleTemplate[],
): RoleTemplate[] {
  const byId = new Map<string, RoleTemplate>();
  if (catalog) {
    for (const t of catalog) {
      if (t.role === "worker") byId.set(t.id, t);
    }
  }
  const out: RoleTemplate[] = [];
  const seen = new Set<string>();
  for (const id of workerTemplates) {
    if (seen.has(id)) continue;
    seen.add(id);
    const fromCatalog = byId.get(id) ?? getRoleTemplate(id);
    if (fromCatalog && fromCatalog.role === "worker") {
      out.push({
        ...fromCatalog,
        labels: [...fromCatalog.labels],
        preferred_adapters: [...fromCatalog.preferred_adapters],
        skills: [...fromCatalog.skills],
      });
    } else {
      out.push(resolveRoleTemplate(id, "worker"));
    }
  }
  // Ensure fallback is present for matching edge cases
  if (!seen.has(FALLBACK_WORKER_TEMPLATE)) {
    const fb = getRoleTemplate(FALLBACK_WORKER_TEMPLATE);
    if (fb) {
      out.push({
        ...fb,
        labels: [...fb.labels],
        preferred_adapters: [...fb.preferred_adapters],
        skills: [...fb.skills],
      });
    }
  }
  return out;
}
