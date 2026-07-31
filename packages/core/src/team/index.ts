/**
 * @lazyorch/core team — manager, role templates, preferred_adapters, ephemeral sessions.
 * PR-13 / KD-3 / KD-25 / KD-26 / KD-35.
 */

export type {
  SessionKindPreference,
  ApprovalPolicy,
  RoleTemplate,
  EphemeralSessionPolicy,
  EffectiveTeamLimits,
  BuildTeamInput,
  BuiltTeam,
} from "./types.js";

export {
  DEFAULT_CODING_PREFERRED_ADAPTERS,
  DEFAULT_QA_PREFERRED_ADAPTERS,
  DEFAULT_PREFERRED_ADAPTERS_BY_ROLE,
  FALLBACK_WORKER_TEMPLATE,
  DEFAULT_ROLE_TEMPLATES,
  cloneRoleTemplate,
  getRoleTemplate,
  listRoleTemplateIds,
  preferredAdaptersForRole,
  resolveRoleTemplate,
  skillsForRoleDefault,
  defaultTemplateIdForRole,
} from "./role-templates.js";

export {
  resolveTeamMode,
  soloForcesTaskApprove,
  mayCollapsePlanWriterAndReviewer,
  type ResolveTeamModeInput,
} from "./mode.js";

export {
  GENERIC_WORKER_TAGS,
  templateTagSet,
  affinityIntersection,
  specializedMatchCount,
  matchWorkerTemplate,
  matchWorkerTemplateForReadyTasks,
  type MatchWorkerTemplateResult,
} from "./match.js";

export {
  DEFAULT_REVIEWER_IDLE_EXIT_MS,
  DEFAULT_REVIEWER_MAX_RESTARTS_PER_HOUR,
  DEFAULT_QA_MAX_RESTARTS_PER_HOUR,
  DEFAULT_LEAD_MAX_RESTARTS_PER_HOUR,
  DEFAULT_LEAD_IDLE_EXIT_MS,
  DEFAULT_QA_IDLE_EXIT_MS,
  defaultEphemeralPolicy,
  shouldIdleExitEphemeral,
  reviewQueueTasks,
  canStartReviewerSession,
  canStartQaSession,
  withinRestartBudget,
  type IdleExitInput,
  type CanStartReviewerInput,
  type CanStartQaInput,
} from "./ephemeral.js";

export {
  buildTeam,
  mintWorkerAgent,
  mintPlanAgent,
  findAgent,
  agentsByRole,
  preferredAdaptersForAgent,
} from "./team-manager.js";
