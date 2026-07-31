/**
 * Adapter registry + discovery (PR-08) + coding adapter create path (PR-09).
 */

export type {
  AdapterCapabilities,
  AdapterRegistration,
  AdapterHealthRow,
  AdapterHealthStatus,
  BuiltinCatalogEntry,
  CapabilityMatrixFlags,
  HealthMatrix,
  UsageReporting,
} from "./types.js";

export {
  BUILTIN_ADAPTER_IDS,
  BUILTIN_CATALOG,
  DEFAULT_TIER_MAPS,
  codingCapabilities,
  shellCapabilities,
  getBuiltinCatalogEntry,
  isBuiltinAdapterId,
  matrixFlagsFor,
  type BuiltinAdapterId,
} from "./catalog.js";

export {
  resolveBinary,
  discoverBinary,
  type DiscoverEnv,
  type DiscoverOptions,
  type DiscoverResult,
} from "./discover.js";

export {
  probeAdapter,
  parseVersionString,
  versionMeetsFloor,
  defaultExecImpl,
  type ExecImpl,
  type ExecResult,
  type ProbeOptions,
} from "./probe.js";

export {
  resolveAdapterRegistrations,
  type ResolveRegistryOptions,
} from "./resolve.js";

export {
  buildHealthMatrix,
  doctorAdapters,
  healthRowFrom,
  type HealthOptions,
} from "./health.js";

export {
  AdapterRegistry,
  createAdapterRegistry,
  type AdapterRegistryOptions,
} from "./registry.js";

export {
  GenericCliAdapter,
  GenericAdapterError,
  createGenericAdapter,
  splitTemplateArgv,
  templateToArgv,
  type TemplateVars,
} from "./generic.js";

export {
  USER_ADAPTER_TEMPLATES,
  getUserAdapterTemplate,
  listUserAdapterTemplates,
  userTemplateToRegistryEntry,
  formatUserTemplateHelp,
  isUserAdapterTemplateId,
  type UserAdapterTemplate,
  type UserAdapterTemplateId,
} from "./user-templates.js";
