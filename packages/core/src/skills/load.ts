/**
 * Skills list/load helpers for session materialization (PR-13 / KD-23).
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRole } from "../types/agent.js";
import {
  BUILTIN_SKILL_IDS,
  DEFAULT_ROLE_SKILLS,
  isBuiltinSkillId,
  SKILL_STUBS,
  type BuiltinSkillId,
} from "./catalog.js";

export interface SkillLoader {
  /** Return markdown for a skill id, or null if missing. */
  load(skillId: string): Promise<string | null> | string | null;
}

/** List built-in skill ids (stable order). */
export function listSkills(): BuiltinSkillId[] {
  return [...BUILTIN_SKILL_IDS];
}

/** Skills bound to a role (default design bindings). */
export function skillsForRole(role: AgentRole): string[] {
  return [...(DEFAULT_ROLE_SKILLS[role] ?? ["careful"])];
}

/**
 * Load skill markdown text.
 * Prefer embedded stubs (always available); optional filesystem override
 * under packages/core/skills/<id>.md when `fromDisk` is true.
 */
export function loadSkill(
  skillId: string,
  options?: { fromDisk?: boolean },
): string | null {
  if (!isBuiltinSkillId(skillId)) return null;
  if (options?.fromDisk === true) {
    // Sync disk load is not provided; use loadSkillAsync for disk.
    return SKILL_STUBS[skillId];
  }
  return SKILL_STUBS[skillId];
}

/**
 * Async load: try packages/core/skills/<id>.md relative to this package,
 * fall back to embedded stub.
 */
export async function loadSkillAsync(skillId: string): Promise<string | null> {
  if (!isBuiltinSkillId(skillId)) return null;
  try {
    const dir = skillsDir();
    if (dir) {
      const path = join(dir, `${skillId}.md`);
      const text = await readFile(path, "utf8");
      if (text.trim().length > 0) return text;
    }
  } catch {
    // fall through to stub
  }
  return SKILL_STUBS[skillId];
}

/** Resolve packages/core/skills directory from this module location. */
export function skillsDir(): string | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/skills → ../../skills  |  src/skills → ../../skills
    return join(here, "..", "..", "skills");
  } catch {
    return null;
  }
}

/**
 * Concatenate skill markdown bodies for injection into prompt.md.
 * Unknown skill ids are skipped.
 */
export function loadSkillsMarkdown(
  skillIds: readonly string[],
): string[] {
  const out: string[] = [];
  for (const id of skillIds) {
    const md = loadSkill(id);
    if (md) out.push(md);
  }
  return out;
}

/** Create a SkillLoader compatible with adapters session materialize. */
export function createSkillLoader(options?: {
  /** Prefer disk files under packages/core/skills/. */
  fromDisk?: boolean;
  /** Extra inline overrides (id → markdown). */
  overrides?: Record<string, string>;
}): SkillLoader {
  const overrides = options?.overrides ?? {};
  const fromDisk = options?.fromDisk === true;
  return {
    load(skillId: string) {
      if (overrides[skillId] !== undefined) return overrides[skillId]!;
      if (fromDisk) return loadSkillAsync(skillId);
      return loadSkill(skillId);
    },
  };
}

/** Empty loader (no skills) — mirrors adapters emptySkillLoader. */
export const emptySkillLoader: SkillLoader = {
  load: () => null,
};
