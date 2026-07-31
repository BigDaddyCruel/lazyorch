/**
 * Planning engine: writer/reviewer ports, freeze validators, consensus loop, replan hooks.
 * No real LLM adapters — inject ports (fakes for tests, adapters later).
 */

export type { PlanWriterPort, PlanReviewerPort } from "./ports.js";

export { FakePlanWriter, FakePlanReviewer } from "./fakes.js";

export {
  DEFAULT_REQUIRED_SECTIONS,
  extractHeadings,
  headingMatches,
  validateTaskDag,
  validateTaskFields,
  validateDesignSections,
  validateDesignSize,
  validatePrPlanCoverage,
  validateScopeOverlaps,
  validateFreeze,
} from "./validators.js";

export {
  materializePlanTasks,
  freezePayload,
  computeFreezeHash,
  buildPlan,
  type BuildPlanOptions,
} from "./materialize.js";

export {
  PlanningError,
  runConsensus,
  applyIssueUpdates,
  forceApproveResidual,
  type RunConsensusParams,
} from "./consensus.js";

export {
  ReplanError,
  supersedeOpenTasks,
  prepareReplan,
  resumeAfterReplan,
  type SupersedeTasksResult,
  type PrepareReplanOptions,
  type PrepareReplanResult,
} from "./replan.js";

export type {
  PlanTaskDraft,
  OverlappingScope,
  TaskDagMeta,
  TaskDag,
  PlanArtifacts,
  IssueUpdate,
  PlanWriteContext,
  PlanWriteResult,
  PlanReviewContext,
  PlanReviewResult,
  FreezeValidatorOptions,
  FreezeValidationError,
  FreezeValidationResult,
  FreezeInput,
  FrozenPlanResult,
  MaxRoundsResult,
  ConsensusResult,
  ConsensusConfig,
} from "./types.js";
