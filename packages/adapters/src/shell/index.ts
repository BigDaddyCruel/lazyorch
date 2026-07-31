export {
  ShellAdapter,
  ShellAdapterError,
  createShellAdapter,
  defaultSpawnImpl,
  type ShellAdapterOptions,
  type SpawnImpl,
  type SpawnRequest,
  type SpawnedProcess,
} from "./adapter.js";

export {
  checkShellAllowlist,
  commandNameFromArgv,
  DEFAULT_SHELL_ALLOWLIST,
  type ShellAllowlistConfig,
  type AllowlistResult,
} from "./allowlist.js";
