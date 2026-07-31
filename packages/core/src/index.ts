/**
 * @lazyorch/core — FSM, tasks, planning, scheduling, and domain types.
 * PR-02: types, IDs, JSON I/O, schema_version, DAG/issue helpers.
 * (FSM transition tables land in PR-03.)
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
