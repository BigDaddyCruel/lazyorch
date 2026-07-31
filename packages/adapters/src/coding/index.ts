/**
 * First-class coding adapters (PR-09): claude, codex, agy, grok.
 */

export {
  CodingCliAdapter,
  CodingAdapterError,
  createCodingAdapter,
  createCodingAdapterForId,
  extractRunHandle,
  type CodingAdapterOptions,
} from "./adapter.js";

export {
  buildCodingArgv,
  expandFlagTemplate,
  resolveCodingBinary,
  isUsableModelId,
  CodingArgvError,
  type BuildCodingArgvOptions,
} from "./argv.js";

export {
  parseUsageFromText,
  parseUsageFromLog,
  parseUsageFromFreeText,
  usageFromJsonObject,
  mergeUsage,
  preferRicherUsage,
} from "./usage.js";

export {
  parseModelListFromText,
  modelsFromJsonValue,
  modelsFromRegistration,
  modelsFromTierMap,
  probeModelList,
  resolveModelList,
  MODEL_ID_MAX_LEN,
  type ModelListProbeOptions,
} from "./models-probe.js";

export {
  CODING_PROFILES,
  FIRST_CLASS_CODING_IDS,
  getCodingProfile,
  isFirstClassCodingId,
  isEffortLevel,
  type CodingAdapterProfile,
  type FirstClassCodingId,
} from "./profiles.js";

export {
  StartRecorder,
  defaultFakeResult,
  resolveRunMode,
  modeAllowsUnbound,
  type CodingRunMode,
  type RecordedStart,
  type FakeSessionResultFactory,
} from "./fake.js";
