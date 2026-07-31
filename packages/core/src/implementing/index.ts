/**
 * Implementing phase: assign/review/integrate loop, forge mutex (KD-33/34),
 * escalate on retry, replan hooks, terminal-failed policy (KD-36).
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
  ForgeIntegrateStatus,
  ForgeIntegrateRequest,
  ForgeIntegrateResult,
  ForgeIntegratePort,
  IntegrationMutexAcquireResult,
  IntegrationMutexPort,
} from "./ports.js";

export {
  ImplementingError,
  applyWorkerOutcome,
  applyReviewDecision,
  applyIntegrateResult,
  recoverIntegrateConflict,
  afterConflictRework,
  type ApplyIntegrateOptions,
  type ApplyIntegrateResult,
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
  applyTerminalFailedPolicy,
  type OnTaskTerminalFailed,
  type TerminalFailedPolicy,
  type TerminalFailedResult,
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
} from "./fakes.js";
