import { describe, expect, it } from "vitest";
import { AGENT_ROLES } from "../types/agent.js";
import {
  DEFAULT_ROLE_TEMPLATES,
  skillsForRoleDefault,
} from "../team/role-templates.js";
import {
  BUILTIN_SKILL_IDS,
  createSkillLoader,
  DEFAULT_ROLE_SKILLS,
  isBuiltinSkillId,
  listSkills,
  loadSkill,
  loadSkillAsync,
  loadSkillsMarkdown,
  skillsForRole,
  SKILL_STUBS,
} from "./index.js";

describe("skills catalog + loaders", () => {
  it("lists all built-in skill ids", () => {
    const ids = listSkills();
    expect(ids).toEqual([...BUILTIN_SKILL_IDS]);
    expect(ids).toContain("careful");
    expect(ids).toContain("review-checklist");
    expect(ids).toContain("qa-runner");
  });

  it("loads stub markdown for each skill", () => {
    for (const id of listSkills()) {
      const md = loadSkill(id);
      expect(md).toBeTruthy();
      expect(md).toContain("# Skill:");
      expect(md).toBe(SKILL_STUBS[id]);
    }
  });

  it("returns null for unknown skill", () => {
    expect(loadSkill("not-a-skill")).toBeNull();
    expect(isBuiltinSkillId("careful")).toBe(true);
    expect(isBuiltinSkillId("nope")).toBe(false);
  });

  it("binds skills per role", () => {
    expect(skillsForRole("worker")).toEqual(["careful", "freeze-scope"]);
    expect(skillsForRole("reviewer")).toEqual(["review-checklist"]);
    expect(skillsForRole("plan_writer")).toEqual(["plan-writer", "careful"]);
    expect(skillsForRole("qa")).toEqual(["qa-runner", "careful"]);
  });

  it("loadSkillsMarkdown concatenates known skills only", () => {
    const parts = loadSkillsMarkdown(["careful", "missing", "freeze-scope"]);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain("careful");
    expect(parts[1]).toContain("freeze-scope");
  });

  it("createSkillLoader serves stubs and overrides", async () => {
    const loader = createSkillLoader({
      overrides: { careful: "# custom careful\n" },
    });
    expect(await Promise.resolve(loader.load("careful"))).toBe(
      "# custom careful\n",
    );
    expect(await Promise.resolve(loader.load("qa-runner"))).toContain(
      "qa-runner",
    );
    expect(await Promise.resolve(loader.load("unknown"))).toBeNull();
  });

  it("loadSkillAsync falls back to stub or reads disk", async () => {
    const md = await loadSkillAsync("careful");
    expect(md).toBeTruthy();
    expect(md).toContain("careful");
  });

  it("role skill bindings stay in parity (catalog / default / templates)", () => {
    for (const role of AGENT_ROLES) {
      expect(skillsForRole(role)).toEqual([...DEFAULT_ROLE_SKILLS[role]]);
      expect(skillsForRoleDefault(role)).toEqual([...DEFAULT_ROLE_SKILLS[role]]);
    }
    for (const tpl of DEFAULT_ROLE_TEMPLATES) {
      expect(tpl.skills).toEqual([...DEFAULT_ROLE_SKILLS[tpl.role]]);
    }
  });
});
