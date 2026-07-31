/**
 * Merge builtin catalog + PATH discovery + user config into AdapterRegistration[].
 *
 * Precedence (design):
 * 1. Builtin catalog loads default candidates
 * 2. PATH discovery for each candidate
 * 3. User config (adapters.<id>.binary / adapters.registry[]) overrides — authoritative
 */

import type {
  AdapterRegistryEntry,
  AdaptersConfig,
  ModelTier,
} from "@lazyorch/shared";
import {
  BUILTIN_CATALOG,
  codingCapabilities,
  getBuiltinCatalogEntry,
  isBuiltinAdapterId,
} from "./catalog.js";
import {
  discoverBinary,
  type DiscoverOptions,
} from "./discover.js";
import type {
  AdapterCapabilities,
  AdapterRegistration,
} from "./types.js";

export interface ResolveRegistryOptions extends DiscoverOptions {
  /** When false, skip PATH lookups (tests with pure fakes). Default true. */
  discover?: boolean;
}

function asTierMap(
  value: unknown,
): Partial<Record<ModelTier, string>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const out: Partial<Record<ModelTier, string>> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string" && v.length > 0) {
      out[k as ModelTier] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function mergeCapabilities(
  base: AdapterCapabilities,
  overlay?: Partial<AdapterCapabilities> | Record<string, unknown>,
  tierMapOverride?: Partial<Record<ModelTier, string>>,
): AdapterCapabilities {
  const fromOverlay = overlay
    ? {
        models: Array.isArray(overlay.models)
          ? (overlay.models as string[])
          : base.models,
        tier_map:
          overlay.tier_map && typeof overlay.tier_map === "object"
            ? (overlay.tier_map as Partial<Record<ModelTier, string>>)
            : base.tier_map,
        streaming:
          typeof overlay.streaming === "boolean"
            ? overlay.streaming
            : base.streaming,
        worktree_ok:
          typeof overlay.worktree_ok === "boolean"
            ? overlay.worktree_ok
            : base.worktree_ok,
        usage_reporting:
          overlay.usage_reporting === "none" ||
          overlay.usage_reporting === "tokens" ||
          overlay.usage_reporting === "tokens_and_cost"
            ? overlay.usage_reporting
            : base.usage_reporting,
        ...(typeof overlay.effort_flag === "boolean"
          ? { effort_flag: overlay.effort_flag }
          : base.effort_flag !== undefined
            ? { effort_flag: base.effort_flag }
            : {}),
        ...(typeof overlay.max_concurrent_hint === "number"
          ? { max_concurrent_hint: overlay.max_concurrent_hint }
          : base.max_concurrent_hint !== undefined
            ? { max_concurrent_hint: base.max_concurrent_hint }
            : {}),
      }
    : { ...base };

  if (tierMapOverride) {
    fromOverlay.tier_map = { ...fromOverlay.tier_map, ...tierMapOverride };
  }
  return fromOverlay;
}

function modelsOverrideFor(
  config: AdaptersConfig,
  id: string,
): Partial<Record<ModelTier, string>> | undefined {
  const models = config.models as Record<string, unknown>;
  return asTierMap(models[id]);
}

async function resolveBuiltin(
  config: AdaptersConfig,
  options: ResolveRegistryOptions,
): Promise<AdapterRegistration[]> {
  const out: AdapterRegistration[] = [];
  const doDiscover = options.discover !== false;

  for (const entry of BUILTIN_CATALOG) {
    if (entry.id === "shell") {
      const shellCfg = config.shell;
      const reg: AdapterRegistration = {
        id: "shell",
        display_name: entry.display_name,
        binary: "shell",
        enabled: shellCfg.enabled,
        source: "builtin",
        capabilities: entry.capabilities,
        binary_path: "shell",
      };
      out.push(reg);
      continue;
    }

    // Builtin toggle: adapters.claude / .codex / .agy / .grok
    const builtinKey = entry.id as "claude" | "codex" | "agy" | "grok";
    const cfg = config[builtinKey];
    const enabled = cfg.enabled;

    const candidates: string[] = [];
    // User binary override is authoritative (first).
    if (cfg.binary) candidates.push(cfg.binary);
    if ("candidates" in cfg && Array.isArray(cfg.candidates) && cfg.candidates.length > 0) {
      candidates.push(...cfg.candidates);
    } else {
      candidates.push(...entry.candidates);
    }
    // De-dupe while preserving order
    const seen = new Set<string>();
    const uniqueCandidates = candidates.filter((c) => {
      if (seen.has(c)) return false;
      seen.add(c);
      return true;
    });

    let binary = uniqueCandidates[0] ?? entry.id;
    let binary_path: string | undefined;
    let unbound = false;
    let source: AdapterRegistration["source"] = "builtin";

    if (cfg.binary) {
      source = "user_config";
      if (doDiscover) {
        const found = await discoverBinary([cfg.binary], options);
        if (found) {
          binary = cfg.binary;
          binary_path = found.binary_path;
        } else {
          // User set an explicit path/name that we cannot resolve — still record it.
          binary = cfg.binary;
          unbound = true;
        }
      } else {
        binary = cfg.binary;
        binary_path = cfg.binary;
      }
    } else if (doDiscover) {
      const found = await discoverBinary(uniqueCandidates, options);
      if (found) {
        binary = found.candidate;
        binary_path = found.binary_path;
        source = "path_discover";
      } else {
        binary = uniqueCandidates[0] ?? entry.id;
        unbound = true;
        source = "builtin";
      }
    } else {
      // Tests without discovery: treat first candidate as nominal binary.
      binary = uniqueCandidates[0] ?? entry.id;
      unbound = true;
    }

    const caps = mergeCapabilities(
      entry.capabilities,
      undefined,
      modelsOverrideFor(config, entry.id),
    );

    const reg: AdapterRegistration = {
      id: entry.id,
      display_name: entry.display_name,
      binary,
      enabled,
      source,
      capabilities: caps,
      version_args: [...entry.version_args],
      candidates: uniqueCandidates,
    };
    if (entry.version_floor) reg.version_floor = entry.version_floor;
    if (entry.args_prefix) reg.args_prefix = [...entry.args_prefix];
    if (entry.start_template) reg.start_template = entry.start_template;
    if (entry.models_args) reg.models_args = [...entry.models_args];
    if (binary_path !== undefined) reg.binary_path = binary_path;
    if (unbound) reg.unbound = true;
    out.push(reg);
  }

  return out;
}

async function resolveUserRegistry(
  config: AdaptersConfig,
  options: ResolveRegistryOptions,
  existingIds: Set<string>,
): Promise<AdapterRegistration[]> {
  const out: AdapterRegistration[] = [];
  const doDiscover = options.discover !== false;

  for (const entry of config.registry) {
    // Shell is reserved — never replace the deterministic builtin row.
    if (entry.id === "shell") {
      continue;
    }
    const reg = await resolveUserEntry(entry, options, doDiscover, config);
    // User registry may override a builtin id (re-bind agy/grok etc.).
    if (existingIds.has(reg.id) && isBuiltinAdapterId(reg.id)) {
      reg.source = "user_config";
    }
    out.push(reg);
  }
  return out;
}

async function resolveUserEntry(
  entry: AdapterRegistryEntry,
  options: ResolveRegistryOptions,
  doDiscover: boolean,
  config: AdaptersConfig,
): Promise<AdapterRegistration> {
  const catalog = getBuiltinCatalogEntry(entry.id);
  const display_name =
    entry.display_name ?? catalog?.display_name ?? entry.id;

  const candidates: string[] = [];
  if (entry.binary) candidates.push(entry.binary);
  if (entry.candidates) candidates.push(...entry.candidates);
  if (candidates.length === 0) candidates.push(entry.id);

  const seen = new Set<string>();
  const uniqueCandidates = candidates.filter((c) => {
    if (seen.has(c)) return false;
    seen.add(c);
    return true;
  });

  let binary = uniqueCandidates[0] ?? entry.id;
  let binary_path: string | undefined;
  let unbound = false;
  let source: AdapterRegistration["source"] =
    entry.source === "builtin" || entry.source === "path_discover"
      ? entry.source
      : "user_config";

  if (doDiscover) {
    const found = await discoverBinary(uniqueCandidates, options);
    if (found) {
      binary = entry.binary ?? found.candidate;
      binary_path = found.binary_path;
      if (!entry.binary) source = "path_discover";
      else source = "user_config";
    } else {
      binary = entry.binary ?? uniqueCandidates[0] ?? entry.id;
      unbound = true;
      source = "user_config";
    }
  } else {
    binary = entry.binary ?? uniqueCandidates[0] ?? entry.id;
    if (entry.binary) binary_path = entry.binary;
    else unbound = true;
  }

  const baseCaps = catalog
    ? catalog.capabilities
    : codingCapabilities(
        entry.capabilities
          ? {
              models: entry.capabilities.models,
              tier_map: entry.capabilities.tier_map as Partial<
                Record<ModelTier, string>
              >,
              streaming: entry.capabilities.streaming,
              worktree_ok: entry.capabilities.worktree_ok,
              usage_reporting: entry.capabilities.usage_reporting,
              ...(entry.capabilities.effort_flag !== undefined
                ? { effort_flag: entry.capabilities.effort_flag }
                : {}),
              ...(entry.capabilities.max_concurrent_hint !== undefined
                ? {
                    max_concurrent_hint: entry.capabilities.max_concurrent_hint,
                  }
                : {}),
            }
          : {},
      );

  const caps = mergeCapabilities(
    baseCaps,
    entry.capabilities,
    modelsOverrideFor(config, entry.id),
  );

  const reg: AdapterRegistration = {
    id: entry.id,
    display_name,
    binary,
    enabled: entry.enabled,
    source,
    capabilities: caps,
  };

  if (entry.args_prefix) reg.args_prefix = [...entry.args_prefix];
  if (entry.version_args) reg.version_args = [...entry.version_args];
  else if (catalog) reg.version_args = [...catalog.version_args];
  else reg.version_args = ["--version"];

  if (entry.version_floor) reg.version_floor = entry.version_floor;
  else if (catalog?.version_floor) reg.version_floor = catalog.version_floor;

  if (entry.models_args) reg.models_args = [...entry.models_args];
  else if (catalog?.models_args) reg.models_args = [...catalog.models_args];

  if (entry.env) reg.env = { ...entry.env };
  if (entry.start_template) reg.start_template = entry.start_template;
  else if (catalog?.start_template) reg.start_template = catalog.start_template;

  if (binary_path !== undefined) reg.binary_path = binary_path;
  if (unbound) reg.unbound = true;
  reg.candidates = uniqueCandidates;

  return reg;
}

/**
 * Build the full resolved registration list.
 * User registry entries with the same id as a builtin **replace** the builtin row,
 * except **shell** which is always the dedicated deterministic registration.
 */
export async function resolveAdapterRegistrations(
  config: AdaptersConfig,
  options: ResolveRegistryOptions = {},
): Promise<AdapterRegistration[]> {
  const builtins = await resolveBuiltin(config, options);
  const byId = new Map<string, AdapterRegistration>();
  for (const b of builtins) byId.set(b.id, b);
  const shellBuiltin = byId.get("shell");

  const user = await resolveUserRegistry(
    config,
    options,
    new Set(byId.keys()),
  );
  for (const u of user) {
    if (u.id === "shell") continue;
    byId.set(u.id, u);
  }

  // Always restore dedicated shell row after merge.
  if (shellBuiltin) {
    byId.set("shell", shellBuiltin);
  }

  // Stable order: builtins first (catalog order), then remaining user ids.
  const ordered: AdapterRegistration[] = [];
  for (const entry of BUILTIN_CATALOG) {
    const reg = byId.get(entry.id);
    if (reg) {
      ordered.push(reg);
      byId.delete(entry.id);
    }
  }
  for (const reg of byId.values()) {
    ordered.push(reg);
  }
  return ordered;
}
