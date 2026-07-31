/**
 * Post-Implementing lifecycle: PrePR / PROpen / CILoop / MergeReady / merge gate.
 * PR-17 MVP cut.
 */

export type {
  MergeMethod,
  EnsureReadyPrPortRequest,
  EnsureReadyPrPortResult,
  PollChecksPortRequest,
  PollChecksPortResult,
  MergePrPortRequest,
  MergePrPortResult,
  ForgeGithubPort,
} from "./ports.js";

export { FakeForgeGithub } from "./fakes.js";

export {
  applyEnsureReadyResult,
  runPrePrPhase,
  runPrOpenPhase,
  withPrRef,
  type PrePrConfig,
  type RunPrePrResult,
} from "./prepr.js";

export {
  runCiLoopTick,
  type CiLoopConfig,
  type RunCiLoopResult,
} from "./ciloop.js";

export {
  createMergeGate,
  hasPendingMergeGate,
  applyMergeGateDecision,
  applyMerged,
  shouldAutoMerge,
  resolvePendingMergeGates,
  applyChangesRequested,
  type CreateMergeGateOpts,
  type MergeGateDecision,
  type ApplyMergeGateDecisionResult,
  type ApplyChangesRequestedOpts,
  type ApplyChangesRequestedResult,
} from "./merge-gate.js";

export {
  lifecycleTick,
  type LifecycleTickParams,
  type LifecycleTickResult,
} from "./phase.js";
