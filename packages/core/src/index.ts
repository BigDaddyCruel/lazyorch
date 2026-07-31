/**
 * @lazyorch/core — FSM, tasks, planning, scheduling, and domain types.
 * PR-02: types, IDs, JSON I/O, schema_version, DAG/issue helpers.
 * PR-03: dual FSM engine (run + task), exit predicate, simulator.
 * PR-05: planning engine (validators, consensus, fake ports, replan hooks).
 */
export const PACKAGE_NAME = "@lazyorch/core" as const;

export { SCHEMA_VERSION, type SchemaVersion } from "./schema.js";

export {
  generateId,
  ID_PREFIXES,
  isPrefixedId,
  parseIdPrefix,
  type IdPrefix,
} from "@lazyorch/shared";

export * from "./types/index.js";

export {
  DagError,
  hasCycle,
  topologicalSort,
  readyWhenDepsDone,
  depsSatisfied,
} from "./dag.js";

export {
  PlanIssueError,
  canTransitionIssueStatus,
  transitionPlanIssue,
  countOpenIssues,
  type TransitionIssueOptions,
} from "./plan-issue.js";

export { readJsonFile, writeJsonFile } from "./store/json-io.js";
export { StateStore } from "./store/state-store.js";

export {
  RunFsmError,
  isTerminalPhase,
  canTransitionRunPhase,
  allowedRunTransitions,
  transitionRunPhase,
  hasReadyPr,
  nextPhaseAfterImplementingExit,
  exitImplementing,
  type TransitionRunOptions,
  TaskFsmError,
  OPEN_TASK_STATUSES,
  isTerminalTaskStatus,
  canTransitionTaskStatus,
  allowedTaskTransitions,
  transitionTaskStatus,
  type TransitionTaskOptions,
  evaluatingImplementingExit,
  canExitImplementing,
  type ExitPredicateParams,
  type ExitPredicateResult,
  SimulatorError,
  applySimEvent,
  applySimEvents,
  advanceParallel,
  tryExitImplementing,
  simulateImplementingToExit,
  type SimState,
  type SimEvent,
} from "./orchestrator/index.js";

export {
  FakePlanWriter,
  FakePlanReviewer,
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
  materializePlanTasks,
  freezePayload,
  computeFreezeHash,
  buildPlan,
  PlanningError,
  runConsensus,
  applyIssueUpdates,
  forceApproveResidual,
  ReplanError,
  supersedeOpenTasks,
  prepareReplan,
  resumeAfterReplan,
  type PlanWriterPort,
  type PlanReviewerPort,
  type PlanTaskDraft,
  type OverlappingScope,
  type TaskDagMeta,
  type TaskDag,
  type PlanArtifacts,
  type IssueUpdate,
  type PlanWriteContext,
  type PlanWriteResult,
  type PlanReviewContext,
  type PlanReviewResult,
  type FreezeValidatorOptions,
  type FreezeValidationError,
  type FreezeValidationResult,
  type FreezeInput,
  type FrozenPlanResult,
  type MaxRoundsResult,
  type ConsensusResult,
  type ConsensusConfig,
  type RunConsensusParams,
  type BuildPlanOptions,
  type SupersedeTasksResult,
  type PrepareReplanOptions,
  type PrepareReplanResult,
} from "./planning/index.js";
