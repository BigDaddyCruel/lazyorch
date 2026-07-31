/**
 * @lazyorch/core skills — minimal v1 skill pack + injection helpers (PR-13 / KD-23).
 */

export {
  BUILTIN_SKILL_IDS,
  DEFAULT_ROLE_SKILLS,
  SKILL_STUBS,
  isBuiltinSkillId,
  type BuiltinSkillId,
} from "./catalog.js";

export {
  listSkills,
  skillsForRole,
  loadSkill,
  loadSkillAsync,
  loadSkillsMarkdown,
  skillsDir,
  createSkillLoader,
  emptySkillLoader,
  type SkillLoader,
} from "./load.js";
