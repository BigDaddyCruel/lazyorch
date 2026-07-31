/**
 * Planning engine: writer/reviewer ports, freeze validators, consensus loop,
 * replan hooks, session-backed handlers + plan gates (PR-15).
 * Real LLM adapters bind via injectable PlanningSessionPort (fakes for tests).
 */

export type {
  PlanWriterPort,
  PlanReviewerPort,
  PlanningRole,
  PlanningSessionPort,
  PlanningSessionRequest,
  PlanningSessionOutcome,
  PlanningRoutingOptions,
} from "./ports.js";

export { FakePlanWriter, FakePlanReviewer } from "./fakes.js";
export { FakePlanningSession, type FakeSessionHandler } from "./session-fakes.js";

export {
  DEFAULT_REQUIRED_SECTIONS,
  extractHeadings,
  headingMatches,
  taskDrafts,
  normalizeDependsOn,
  textReferencesTaskId,
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
  residualRisksFromIssues,
  completeForceApprove,
  detectPlanDispute,
  wontfixIssueIds,
  type RunConsensusParams,
  type CompleteForceApproveParams,
  type CompleteForceApproveResult,
} from "./consensus.js";

export {
  ReplanError,
  supersedeOpenTasks,
  prepareReplan,
  resumeAfterReplan,
  type SupersedeTasksResult,
  type PrepareReplanOptions,
  type PrepareReplanResult,
  type ResumeAfterReplanOptions,
} from "./replan.js";

export {
  PLAN_MAX_ROUNDS_ACTIONS,
  createPlanApproveGate,
  createPlanDisputeGate,
  createPlanMaxRoundsGate,
  resolveGate,
  applyPlanApproveDecision,
  applyPlanDisputeDecision,
  applyPlanMaxRoundsDecision,
  shouldOpenPlanApproveGate,
  type PlanMaxRoundsAction,
  type PlanRejectAction,
  type PlanDisputeResolution,
  type CreatePlanGateBase,
  type ResolvePlanApproveResult,
  type ResolvePlanDisputeResult,
  type ResolvePlanMaxRoundsResult,
} from "./gates.js";

export {
  planningSignals,
  routePlanningSession,
  type RoutePlanningSessionParams,
} from "./route.js";

export {
  SessionPlanWriter,
  SessionPlanReviewer,
  type SessionHandlerBase,
  type SessionPlanWriterOptions,
  type SessionPlanReviewerOptions,
} from "./handlers.js";

export {
  runPlanningPhase,
  type RunPlanningPhaseParams,
  type PlanningPhaseResult,
} from "./phase.js";

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
  FreezeValidationCode,
  FreezeValidationError,
  FreezeValidationResult,
  FreezeInput,
  FrozenPlanResult,
  MaxRoundsResult,
  DisputeResult,
  ConsensusResult,
  ConsensusConfig,
} from "./types.js";
