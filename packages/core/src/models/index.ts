/**
 * Model complexity router (PR-10 / KD-38 / KD-41 / KD-42).
 */

export type {
  ComplexitySignals,
  SessionKind,
  RouteReason,
  EffortLevel,
  ModelPin,
  ComplexityWeights,
  ScoreBands,
  ModelsRoutingConfig,
  AdapterRouteInfo,
  EscalateContext,
  RouteInput,
  PartialDeepModelsConfig,
  RouteResult,
  ModelRoutedPayload,
  EstimateResult,
} from "./types.js";

export {
  DEFAULT_ROLE_BASE,
  DEFAULT_UNKNOWN_ROLE_BASE,
  DEFAULT_COMPLEXITY_WEIGHTS,
  DEFAULT_SCORE_BANDS,
  TIER_BAND_MIDPOINT,
  DEFAULT_ROLE_TIER_FLOOR,
  DEFAULT_TIER_MAPS,
  DEFAULT_PREFERENCE_ORDER,
  DEFAULT_ADAPTERS_DEFAULT,
  DEFAULT_MODELS_ROUTING_CONFIG,
  defaultAdaptersForRouting,
} from "./defaults.js";

export {
  tierIndex,
  maxTier,
  minTier,
  nextTier,
  prevTier,
  mapTierToEffort,
  scoreToTier,
  tierBandMidpoint,
  tierForModelId,
} from "./tiers.js";

export {
  clampScore,
  roleBase,
  locBucket,
  planTierSoftPrior,
  securityRiskHit,
  estimateComplexity,
  normalizeSignals,
} from "./estimator.js";

export { mergeModelsConfig } from "./config.js";

export {
  pickAdapter,
  inferTierForModel,
  type PickAdapterInput,
  type PickAdapterResult,
} from "./pick-adapter.js";

export {
  isDeterministicPath,
  resolvePins,
  routeModel,
  route,
} from "./router.js";

export {
  toModelRoutedPayload,
  modelRoutedEvent,
  MODEL_ROUTED_EVENT,
} from "./events.js";

export {
  dryRunRoute,
  type DryRunRouteParams,
  type DryRunRouteResult,
} from "./dry-run.js";
