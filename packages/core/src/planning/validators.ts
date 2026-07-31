import { DagError, hasCycle, topologicalSort } from "../dag.js";
import { countOpenIssues } from "../plan-issue.js";
import type {
  FreezeInput,
  FreezeValidationError,
  FreezeValidationResult,
  FreezeValidatorOptions,
  PlanTaskDraft,
  TaskDag,
} from "./types.js";

/**
 * Required DESIGN.md section headings (design-lazyorch).
 * Matched case-insensitively against markdown heading text.
 */
export const DEFAULT_REQUIRED_SECTIONS: readonly string[] = [
  "Title",
  "Overview",
  "Background",
  "Goals",
  "Proposed design",
  "API",
  "Data model",
  "Alternatives",
  "Security",
  "Observability",
  "Rollout",
  "Open questions",
  "Key Decisions",
  "PR Plan",
] as const;

const DEFAULT_MAX_DESIGN_BYTES = 524_288;

/**
 * Extract markdown heading texts (`#` … `######`).
 */
export function extractHeadings(markdown: string): string[] {
  const headings: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (m?.[2]) {
      headings.push(m[2].replace(/#+\s*$/, "").trim());
    }
  }
  return headings;
}

/**
 * True if some heading contains `required` as a case-insensitive substring,
 * or required contains the heading (short aliases like "API" vs "API / interface changes").
 */
export function headingMatches(headings: readonly string[], required: string): boolean {
  const needle = required.trim().toLowerCase();
  if (needle === "") return true;
  return headings.some((h) => {
    const hay = h.toLowerCase();
    return hay.includes(needle) || needle.includes(hay);
  });
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function nonEmptyStringArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => nonEmptyString(v))
  );
}

/** Validate TASK_DAG structure: DAG, deps exist, required task fields. */
export function validateTaskDag(
  dag: TaskDag,
): FreezeValidationError[] {
  const errors: FreezeValidationError[] = [];
  const tasks = dag.tasks ?? [];

  if (tasks.length === 0) {
    errors.push({
      code: "empty_dag",
      message: "TASK_DAG has no tasks",
    });
    return errors;
  }

  const ids = new Set<string>();
  for (const t of tasks) {
    if (ids.has(t.id)) {
      errors.push({
        code: "duplicate_id",
        message: `Duplicate task id: ${t.id}`,
        path: t.id,
      });
    }
    ids.add(t.id);
  }

  // Field presence
  for (const t of tasks) {
    errors.push(...validateTaskFields(t));
  }

  // Missing deps + cycles via existing DAG helpers
  try {
    topologicalSort(tasks.map((t) => ({ id: t.id, depends_on: t.depends_on })));
  } catch (e) {
    if (e instanceof DagError) {
      if (e.code === "cycle") {
        errors.push({ code: "cycle", message: e.message });
      } else if (e.code === "missing_dep") {
        errors.push({ code: "missing_dep", message: e.message });
      } else if (e.code === "duplicate_id") {
        // already reported above; keep message if we missed it
        if (!errors.some((x) => x.code === "duplicate_id")) {
          errors.push({ code: "duplicate_id", message: e.message });
        }
      }
    } else {
      throw e;
    }
  }

  // hasCycle is redundant with topo sort but explicit for empty-dep graphs with cycles
  // only when topo didn't already catch (e.g. if we skipped topo due to dups)
  if (!errors.some((x) => x.code === "cycle" || x.code === "duplicate_id")) {
    try {
      if (hasCycle(tasks.map((t) => ({ id: t.id, depends_on: t.depends_on })))) {
        errors.push({
          code: "cycle",
          message: "TASK_DAG contains a cycle",
        });
      }
    } catch {
      // duplicate_id already handled
    }
  }

  return errors;
}

export function validateTaskFields(t: PlanTaskDraft): FreezeValidationError[] {
  const errors: FreezeValidationError[] = [];
  if (!nonEmptyString(t.title)) {
    errors.push({
      code: "empty_title",
      message: `Task ${t.id} has empty title`,
      path: t.id,
    });
  }
  if (!nonEmptyString(t.description)) {
    errors.push({
      code: "empty_description",
      message: `Task ${t.id} has empty description`,
      path: t.id,
    });
  }
  if (!nonEmptyStringArray(t.acceptance)) {
    errors.push({
      code: "empty_acceptance",
      message: `Task ${t.id} has empty acceptance[]`,
      path: t.id,
    });
  }
  if (!nonEmptyStringArray(t.scope)) {
    errors.push({
      code: "empty_scope",
      message: `Task ${t.id} has empty scope[]`,
      path: t.id,
    });
  }
  if (!nonEmptyStringArray(t.role_affinity)) {
    errors.push({
      code: "empty_role_affinity",
      message: `Task ${t.id} has empty role_affinity[]`,
      path: t.id,
    });
  }
  return errors;
}

/** Required DESIGN.md section headings present (case-insensitive). */
export function validateDesignSections(
  designMd: string,
  required: readonly string[] = DEFAULT_REQUIRED_SECTIONS,
): FreezeValidationError[] {
  const headings = extractHeadings(designMd);
  const errors: FreezeValidationError[] = [];
  for (const section of required) {
    if (!headingMatches(headings, section)) {
      errors.push({
        code: "missing_section",
        message: `DESIGN.md missing required section heading matching "${section}"`,
        path: section,
      });
    }
  }
  return errors;
}

export function validateDesignSize(
  designMd: string,
  maxBytes: number = DEFAULT_MAX_DESIGN_BYTES,
): FreezeValidationError[] {
  const bytes = Buffer.byteLength(designMd, "utf8");
  if (bytes > maxBytes) {
    return [
      {
        code: "design_too_large",
        message: `DESIGN.md is ${bytes} bytes (max ${maxBytes})`,
      },
    ];
  }
  return [];
}

/** Every plan-origin task id must appear in PR_PLAN.md. */
export function validatePrPlanCoverage(
  prPlanMd: string,
  taskIds: readonly string[],
): FreezeValidationError[] {
  const errors: FreezeValidationError[] = [];
  for (const id of taskIds) {
    if (!prPlanMd.includes(id)) {
      errors.push({
        code: "pr_plan_coverage",
        message: `PR_PLAN.md does not reference task ${id}`,
        path: id,
      });
    }
  }
  return errors;
}

/**
 * Detect pairwise scope string equality overlaps not declared in
 * TASK_DAG.meta.overlapping_scopes. Conservative: only exact scope-entry
 * matches (full lock lattice lives in forge).
 */
export function validateScopeOverlaps(
  dag: TaskDag,
  strict: boolean,
): FreezeValidationError[] {
  if (!strict) return [];

  const tasks = dag.tasks ?? [];
  const declared = new Set<string>();
  for (const entry of dag.meta?.overlapping_scopes ?? []) {
    const sorted = [...entry.task_ids].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        declared.add(`${sorted[i]}|${sorted[j]}`);
      }
    }
  }

  const errors: FreezeValidationError[] = [];
  for (let i = 0; i < tasks.length; i++) {
    const a = tasks[i]!;
    const aScopes = new Set(a.scope.map((s) => s.trim()).filter(Boolean));
    for (let j = i + 1; j < tasks.length; j++) {
      const b = tasks[j]!;
      const shared: string[] = [];
      for (const s of b.scope) {
        const t = s.trim();
        if (t && aScopes.has(t)) shared.push(t);
      }
      if (shared.length === 0) continue;
      const pair = [a.id, b.id].sort();
      const key = `${pair[0]}|${pair[1]}`;
      if (!declared.has(key)) {
        errors.push({
          code: "scope_overlap",
          message: `Tasks ${a.id} and ${b.id} share scope(s) ${shared.join(", ")} without meta.overlapping_scopes entry`,
          path: key,
        });
      }
    }
  }
  return errors;
}

/**
 * Full freeze validators (design-lazyorch § freeze validators).
 * All must pass; open issues must be 0.
 */
export function validateFreeze(input: FreezeInput): FreezeValidationResult {
  const opts: FreezeValidatorOptions = input.options ?? {};
  const maxBytes = opts.max_design_bytes ?? DEFAULT_MAX_DESIGN_BYTES;
  const strictScopes = opts.strict_scopes ?? true;
  const required = opts.required_sections ?? DEFAULT_REQUIRED_SECTIONS;

  const errors: FreezeValidationError[] = [];

  const open = countOpenIssues(input.issues);
  if (open > 0) {
    errors.push({
      code: "open_issues",
      message: `${open} open plan issue(s) block freeze`,
    });
  }

  const { artifacts } = input;
  errors.push(...validateTaskDag(artifacts.task_dag));
  errors.push(...validateDesignSections(artifacts.design_md, required));
  errors.push(...validateDesignSize(artifacts.design_md, maxBytes));
  errors.push(
    ...validatePrPlanCoverage(
      artifacts.pr_plan_md,
      artifacts.task_dag.tasks.map((t) => t.id),
    ),
  );
  errors.push(...validateScopeOverlaps(artifacts.task_dag, strictScopes));

  return { ok: errors.length === 0, errors };
}
