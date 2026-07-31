export {
  createSessionRunner,
  generateRunHandle,
  projectRunDir,
  SessionRunnerError,
  type SessionRunner,
  type SessionRunnerOptions,
  type StartSessionParams,
  type ManagedRunningAgent,
} from "./session-runner.js";

export {
  materializeSession,
  buildPromptMarkdown,
  substituteStartTemplate,
  emptySkillLoader,
  type SkillLoader,
  type MaterializeOptions,
  type MaterializeResult,
} from "./materialize.js";

export {
  mapSessionResultToTaskEffect,
  mapCancelEffect,
  decisionSummary,
  type TaskFsmEffect,
  type MappedTaskStatus,
  type MapResultOptions,
  type CancelReason,
} from "./result-map.js";

export {
  parseStructuredDecision,
  parseLastStdoutJsonLine,
  resolveStructuredDecision,
  readResultJsonFile,
  resultJsonPath,
} from "./result-parse.js";

export {
  BudgetHoursTracker,
  type BudgetHoursLimits,
  type BudgetHoursSnapshot,
  type BudgetHardStopResult,
  type BudgetStopReason,
  type BudgetHoursTrackerOptions,
  type SessionHoursEntry,
} from "./budget-hours.js";

export {
  sessionsFilePath,
  runSessionsDir,
  sessionDirFor,
  emptySessionsFile,
  readSessionsFile,
  writeSessionsFile,
  registerSession,
  updateSessionRecord,
  clearSession,
  countRunningSessions,
} from "./sessions-table.js";
