/**
 * @lazyorch/core scheduler — slots, elastic workers, assign (+ router).
 * PR-12: KD-11 / KD-19 / KD-26 / KD-28; model router at session assign.
 */

export {
  sessionHoldsSlot,
  phaseNeedsLeadReservation,
  computeSlotUsage,
  freeForWorkers,
  canStartSession,
  canStartWorkerAssignment,
  freeForWorkersFromSessions,
  slotLimitsFromConfig,
} from "./slots.js";

export {
  clampInt,
  computeDesiredWorkers,
  applyHostPressure,
  decideScale,
  idleDrainCandidates,
} from "./elasticity.js";

export {
  REMAINING_STATUSES,
  isRemainingStatus,
  criticalPathLengths,
  isOnCriticalPath,
  sortReadyForAssign,
} from "./critical-path.js";

export {
  assignReadyTasks,
  assignReadyTasksAsync,
  releaseTaskScopeLocks,
  pickIdleWorker,
  maxAssignTowardDesired,
  type AssignReadyOptions,
  type AssignRoutingOptions,
} from "./assign.js";

export { SchedulerMetrics } from "./metrics.js";

export {
  planElasticity,
  clampSpawnAfterAssign,
  filterDrainHandlesAfterAssign,
  isStillDrainable,
  applyAssignToSessions,
  schedulerTick,
  schedulerTickAsync,
  defaultSchedulerConfig,
  type SchedulerTickInput,
  type SchedulerTickResult,
} from "./scheduler.js";

export { FakeScopeLockManager, FakeWorktreePort } from "./fakes.js";

export {
  LEAD_RESERVE_PHASES,
  emptySchedulerRuntime,
  type SchedulerSessionState,
  type SchedulerSession,
  type SlotUsage,
  type SlotLimits,
  type FreeForWorkersInput,
  type ScopeLockAcquireResult,
  type ScopeLockPort,
  type WorktreePaths,
  type WorktreePort,
  type HostPressure,
  type DesiredWorkersInput,
  type ScaleActionKind,
  type ScaleDecision,
  type ScopeLockWait,
  type AssignTaskResult,
  type AssignSkipReason,
  type AssignSkip,
  type AssignBatchResult,
  type SchedulerConfig,
  type SchedulerRuntimeState,
} from "./types.js";
