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
 * Matched case-insensitively: a heading must *contain* the required string.
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
 * True if some heading contains `required` as a case-insensitive substring.
 * Only heading→contains→required (not the reverse), so short headings like
 * "S" cannot satisfy "Security".
 */
export function headingMatches(
  headings: readonly string[],
  required: string,
): boolean {
  const needle = required.trim().toLowerCase();
  if (needle === "") return true;
  return headings.some((h) => h.toLowerCase().includes(needle));
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

/** Safe task list from a possibly malformed TASK_DAG. */
export function taskDrafts(dag: TaskDag | null | undefined): PlanTaskDraft[] {
  return Array.isArray(dag?.tasks) ? dag.tasks : [];
}

/**
 * Normalize depends_on to a string array when possible.
 * Returns null when the field is present but not a valid string array.
 * Missing/undefined is treated as [] (valid empty deps).
 */
export function normalizeDependsOn(
  value: unknown,
): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  if (!value.every((v) => typeof v === "string")) return null;
  return value as string[];
}

/** Escape a string for use inside a RegExp character class / pattern. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True if `id` appears in text as a whole token
 * (not a substring of a longer id like tsk_1 inside tsk_10).
 */
export function textReferencesTaskId(text: string, id: string): boolean {
  if (!nonEmptyString(id)) return false;
  const re = new RegExp(
    `(^|[^A-Za-z0-9_])${escapeRegExp(id)}([^A-Za-z0-9_]|$)`,
  );
  return re.test(text);
}

/** Validate TASK_DAG structure: DAG, deps exist, required task fields. */
export function validateTaskDag(dag: TaskDag | null | undefined): FreezeValidationError[] {
  const errors: FreezeValidationError[] = [];
  const tasks = taskDrafts(dag);

  if (tasks.length === 0) {
    errors.push({
      code: "empty_dag",
      message: "TASK_DAG has no tasks",
    });
    return errors;
  }

  const ids = new Set<string>();
  for (const t of tasks) {
    const id = typeof t.id === "string" ? t.id : "";
    if (ids.has(id) && nonEmptyString(id)) {
      errors.push({
        code: "duplicate_id",
        message: `Duplicate task id: ${id}`,
        path: id,
      });
    }
    if (nonEmptyString(id)) {
      ids.add(id);
    }
  }

  // Field presence (including id + depends_on shape)
  for (const t of tasks) {
    errors.push(...validateTaskFields(t));
  }

  // Build nodes with normalized depends_on for DAG helpers (never throw TypeError)
  const nodes: { id: string; depends_on: string[] }[] = [];
  for (const t of tasks) {
    const id = typeof t.id === "string" ? t.id.trim() : "";
    if (!nonEmptyString(id)) continue; // empty_id already reported
    const deps = normalizeDependsOn(t.depends_on);
    if (deps === null) {
      // already reported as invalid_depends_on in validateTaskFields
      nodes.push({ id, depends_on: [] });
      continue;
    }
    nodes.push({ id, depends_on: deps });
  }

  if (nodes.length === 0) {
    return errors;
  }

  // Missing deps + cycles via existing DAG helpers
  try {
    topologicalSort(nodes);
  } catch (e) {
    if (e instanceof DagError) {
      if (e.code === "cycle") {
        errors.push({ code: "cycle", message: e.message });
      } else if (e.code === "missing_dep") {
        errors.push({ code: "missing_dep", message: e.message });
      } else if (e.code === "duplicate_id") {
        if (!errors.some((x) => x.code === "duplicate_id")) {
          errors.push({ code: "duplicate_id", message: e.message });
        }
      }
    } else {
      throw e;
    }
  }

  if (!errors.some((x) => x.code === "cycle" || x.code === "duplicate_id")) {
    try {
      if (hasCycle(nodes)) {
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
  const idLabel =
    typeof t.id === "string" && t.id.trim() !== "" ? t.id : "<missing-id>";

  if (!nonEmptyString(t.id)) {
    errors.push({
      code: "empty_id",
      message: "Task has empty or missing id",
      path: idLabel,
    });
  }

  const deps = normalizeDependsOn(t.depends_on);
  if (deps === null) {
    errors.push({
      code: "invalid_depends_on",
      message: `Task ${idLabel} has invalid depends_on (must be a string array)`,
      path: idLabel,
    });
  }

  if (!nonEmptyString(t.title)) {
    errors.push({
      code: "empty_title",
      message: `Task ${idLabel} has empty title`,
      path: idLabel,
    });
  }
  if (!nonEmptyString(t.description)) {
    errors.push({
      code: "empty_description",
      message: `Task ${idLabel} has empty description`,
      path: idLabel,
    });
  }
  if (!nonEmptyStringArray(t.acceptance)) {
    errors.push({
      code: "empty_acceptance",
      message: `Task ${idLabel} has empty acceptance[]`,
      path: idLabel,
    });
  }
  if (!nonEmptyStringArray(t.scope)) {
    errors.push({
      code: "empty_scope",
      message: `Task ${idLabel} has empty scope[]`,
      path: idLabel,
    });
  }
  if (!nonEmptyStringArray(t.role_affinity)) {
    errors.push({
      code: "empty_role_affinity",
      message: `Task ${idLabel} has empty role_affinity[]`,
      path: idLabel,
    });
  }
  return errors;
}

/** Required DESIGN.md section headings present (case-insensitive). */
export function validateDesignSections(
  designMd: string,
  required: readonly string[] = DEFAULT_REQUIRED_SECTIONS,
): FreezeValidationError[] {
  const headings = extractHeadings(designMd ?? "");
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
  const bytes = Buffer.byteLength(designMd ?? "", "utf8");
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

/** Every plan-origin task id must appear in PR_PLAN.md as a whole token. */
export function validatePrPlanCoverage(
  prPlanMd: string,
  taskIds: readonly string[],
): FreezeValidationError[] {
  const errors: FreezeValidationError[] = [];
  const text = prPlanMd ?? "";
  for (const id of taskIds) {
    if (!nonEmptyString(id)) {
      errors.push({
        code: "pr_plan_coverage",
        message: "PR_PLAN.md cannot cover empty task id",
        path: id,
      });
      continue;
    }
    if (!textReferencesTaskId(text, id)) {
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
  dag: TaskDag | null | undefined,
  strict: boolean,
): FreezeValidationError[] {
  if (!strict) return [];

  const tasks = taskDrafts(dag);
  const declared = new Set<string>();
  for (const entry of dag?.meta?.overlapping_scopes ?? []) {
    const sorted = [...(entry.task_ids ?? [])].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        declared.add(`${sorted[i]}|${sorted[j]}`);
      }
    }
  }

  const errors: FreezeValidationError[] = [];
  for (let i = 0; i < tasks.length; i++) {
    const a = tasks[i]!;
    const aScopeList = Array.isArray(a.scope) ? a.scope : [];
    const aScopes = new Set(
      aScopeList
        .filter((s): s is string => typeof s === "string")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    for (let j = i + 1; j < tasks.length; j++) {
      const b = tasks[j]!;
      const bScopeList = Array.isArray(b.scope) ? b.scope : [];
      const shared: string[] = [];
      for (const s of bScopeList) {
        if (typeof s !== "string") continue;
        const t = s.trim();
        if (t && aScopes.has(t)) shared.push(t);
      }
      if (shared.length === 0) continue;
      const pair = [String(a.id ?? ""), String(b.id ?? "")].sort();
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
 * Total function: never throws on malformed drafts — returns structured errors.
 * All must pass; open issues must be 0.
 */
export function validateFreeze(input: FreezeInput): FreezeValidationResult {
  const opts: FreezeValidatorOptions = input.options ?? {};
  const maxBytes = opts.max_design_bytes ?? DEFAULT_MAX_DESIGN_BYTES;
  const strictScopes = opts.strict_scopes ?? true;
  const required = opts.required_sections ?? DEFAULT_REQUIRED_SECTIONS;

  const errors: FreezeValidationError[] = [];

  const open = countOpenIssues(input.issues ?? []);
  if (open > 0) {
    errors.push({
      code: "open_issues",
      message: `${open} open plan issue(s) block freeze`,
    });
  }

  const artifacts = input.artifacts;
  const dag = artifacts?.task_dag;
  const tasks = taskDrafts(dag);

  errors.push(...validateTaskDag(dag));
  errors.push(...validateDesignSections(artifacts?.design_md ?? "", required));
  errors.push(...validateDesignSize(artifacts?.design_md ?? "", maxBytes));
  errors.push(
    ...validatePrPlanCoverage(
      artifacts?.pr_plan_md ?? "",
      tasks.map((t) => (typeof t.id === "string" ? t.id : "")),
    ),
  );
  errors.push(...validateScopeOverlaps(dag, strictScopes));

  return { ok: errors.length === 0, errors };
}
