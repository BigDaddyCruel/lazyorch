/**
 * Implementing phase: assign/review/integrate loop, forge mutex (KD-33/34),
 * escalate on retry, run-level QA, replan hooks, terminal-failed policy (KD-36).
 */

export type {
  WorkerOutcomeKind,
  WorkerSessionRequest,
  WorkerSessionOutcome,
  WorkerSessionPort,
  ReviewDecision,
  ReviewerSessionRequest,
  ReviewerSessionOutcome,
  ReviewerSessionPort,
  QaSessionRequest,
  QaSessionOutcome,
  QaSessionPort,
  ForgeIntegrateStatus,
  ForgeIntegrateRequest,
  ForgeIntegrateResult,
  ForgeIntegratePort,
  IntegrationMutexAcquireResult,
  IntegrationMutexPort,
} from "./ports.js";

export {
  ImplementingError,
  isIntegrateConflictRework,
  applyWorkerOutcome,
  applyReviewDecision,
  applyIntegrateResult,
  recoverIntegrateConflict,
  afterConflictRework,
  type ApplyIntegrateResult,
  type RecoverIntegrateConflictResult,
} from "./outcomes.js";

export {
  integrateOne,
  drainIntegrateQueue,
  sortIntegratingQueue,
  type IntegrateOneParams,
  type IntegrateOneResult,
} from "./integrate.js";

export {
  terminalFailedTasks,
  coveredByPendingIntervention,
  applyTerminalFailedPolicy,
  createHumanInterventionGate,
  applyConflictStormPolicy,
  type OnTaskTerminalFailed,
  type HumanInterventionReason,
  type TerminalFailedPolicy,
  type TerminalFailedResult,
  type CreateHumanInterventionGateOpts,
} from "./terminal-failed.js";

export {
  implementingTick,
  prepareImplementingReplan,
  resumeImplementingAfterReplan,
  prepareReplan,
  resumeAfterReplan,
  type ImplementingTickParams,
  type ImplementingTickResult,
  type PrepareReplanOptions,
  type PrepareReplanResult,
  type ResumeAfterReplanOptions,
} from "./phase.js";

export {
  FakeIntegrationMutex,
  FakeForgeIntegrate,
  FakeWorkerSession,
  FakeReviewerSession,
  FakeQaSession,
} from "./fakes.js";

export {
  needsRunLevelQa,
  candidatesForRunLevelQa,
  applyQaPass,
  invalidateRunQa,
  createDynamicFixTasks,
  applyQaOutcome,
  canExitAfterQa,
  type DynamicFixReason,
  type CreateDynamicFixTasksOpts,
  type ApplyQaOutcomeResult,
} from "./qa.js";
