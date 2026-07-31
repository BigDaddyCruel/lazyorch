/**
 * @lazyorch/shared — logging, ids, config schemas (zod).
 */
export const PACKAGE_NAME = "@lazyorch/shared" as const;

export function sharedPlaceholder(): string {
  return PACKAGE_NAME;
}

export {
  SCHEMA_VERSION,
  type SchemaVersion,
} from "./schema-version.js";

export {
  generateId,
  ID_PREFIXES,
  isPrefixedId,
  parseIdPrefix,
  type IdPrefix,
} from "./ids.js";

export {
  validateSlotPacking,
  minSlotDemand,
  peakSlotDemand,
  MODEL_TIERS,
  ModelTierSchema,
  AdapterSourceSchema,
  AdapterCapabilitiesSchema,
  AdapterRegistryEntrySchema,
  BuiltinAdapterConfigSchema,
  AdaptersConfigSchema,
  ModelsConfigSchema,
  ElasticityConfigSchema,
  SchedulingConfigSchema,
  ReserveSlotsConfigSchema,
  TeamConfigSchema,
  GatesConfigSchema,
  PlanningConfigSchema,
  FeaturesConfigSchema,
  ProjectMetaConfigSchema,
  WorkspaceConfigSchema,
  ForgeConfigSchema,
  ModelRateSchema,
  BudgetConfigSchema,
  ShellConfigSchema,
  ContextConfigSchema,
  LeadConfigSchema,
  ReviewerConfigSchema,
  QaConfigSchema,
  LazyorchConfigSchema,
  ConfigValidationError,
  parseConfig,
  parseConfigYaml,
  defaultConfig,
  stringifyConfigYaml,
  slotPackingForConfig,
  DEFAULT_CONFIG_OVERRIDES,
  createDefaultConfig,
  type SlotPackingInput,
  type SlotPackingResult,
  type ModelTier,
  type AdapterSource,
  type AdapterRegistryEntry,
  type AdaptersConfig,
  type ModelsConfig,
  type ElasticityConfig,
  type SchedulingConfig,
  type ReserveSlotsConfig,
  type TeamConfig,
  type GatesConfig,
  type ModelRate,
  type BudgetConfig,
  type LazyorchConfig,
  type LazyorchConfigInput,
  type ParseConfigResult,
  type ParseConfigOptions,
} from "./config/index.js";
