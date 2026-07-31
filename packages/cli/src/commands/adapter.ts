/**
 * `lazyorch adapter list|register|test` — registry management (PR-08).
 */
import { access, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  AdapterRegistry,
  type AdapterHealthRow,
  type AdapterRegistration,
  type HealthMatrix,
} from "@lazyorch/adapters";
import {
  AdapterRegistryEntrySchema,
  ConfigValidationError,
  parseConfigYaml,
  stringifyConfigYaml,
  type AdapterRegistryEntry,
  type LazyorchConfig,
} from "@lazyorch/shared";

export type AdapterSubcommand = "list" | "register" | "test";

export interface AdapterCommandOptions {
  action: AdapterSubcommand;
  /** Repository root (default cwd). */
  repo?: string;
  /** Adapter id for test / register. */
  id?: string;
  /** Binary path/name for register. */
  binary?: string;
  /** Display name for register. */
  displayName?: string;
  /** start_template for register. */
  startTemplate?: string;
  /** JSON capabilities blob for register. */
  capabilitiesJson?: string;
  /** When true, list only enabled. */
  enabledOnly?: boolean;
  /**
   * When true, list runs live version probes (default false — resolve-only).
   * `adapter test` always probes.
   */
  probe?: boolean;
  /** @deprecated Prefer default resolve-only list; use probe:true to opt in. */
  skipProbe?: boolean;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

export interface AdapterCommandResult {
  exitCode: number;
  action: AdapterSubcommand;
  matrix?: HealthMatrix;
  registration?: AdapterRegistration;
  message?: string;
  configPath?: string;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function loadConfig(
  repo: string,
): Promise<{ config: LazyorchConfig; configPath: string }> {
  const configPath = join(repo, ".lazyorch", "config.yml");
  if (!(await pathExists(configPath))) {
    throw new Error(`missing ${configPath} — run \`lazyorch init\` first`);
  }
  const yamlText = await readFile(configPath, "utf8");
  const { config } = parseConfigYaml(yamlText, { enforcePacking: false });
  return { config, configPath };
}

function formatRow(row: AdapterHealthRow): string {
  const status = row.status.padEnd(8);
  const bin = row.binary_path ?? row.binary ?? "-";
  const ver = row.version ? ` v${row.version}` : "";
  const unbound = row.unbound ? " [unbound]" : "";
  const disabled = !row.enabled ? " [disabled]" : "";
  return `${status} ${row.id.padEnd(12)} ${row.source.padEnd(14)} ${bin}${ver}${unbound}${disabled}`;
}

/**
 * Run `lazyorch adapter list|register|test`.
 */
export async function runAdapter(
  options: AdapterCommandOptions,
): Promise<AdapterCommandResult> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const repo = resolve(options.repo ?? process.cwd());

  try {
    switch (options.action) {
      case "list":
        return await listAdapters(repo, options, stdout);
      case "register":
        return await registerAdapter(repo, options, stdout);
      case "test":
        return await testAdapter(repo, options, stdout);
      default:
        stderr.write(`error: unknown adapter action\n`);
        return { exitCode: 2, action: options.action };
    }
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      for (const issue of err.issues) {
        stderr.write(`error: ${issue}\n`);
      }
      return { exitCode: 1, action: options.action, message: err.message };
    }
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(`error: ${msg}\n`);
    return { exitCode: 1, action: options.action, message: msg };
  }
}

/**
 * Classify doctor/probe outcome for CLI exit codes.
 * Unbound / disabled → warn (exit 0); hard probe failures → fail (exit 1).
 */
export function classifyProbeExit(d: {
  ok: boolean;
  unbound?: boolean;
}): { tag: string; exitCode: number; soft: boolean } {
  if (d.ok) return { tag: "ok  ", exitCode: 0, soft: false };
  if (d.unbound) return { tag: "WARN", exitCode: 0, soft: true };
  return { tag: "FAIL", exitCode: 1, soft: false };
}

async function listAdapters(
  repo: string,
  options: AdapterCommandOptions,
  stdout: NodeJS.WritableStream,
): Promise<AdapterCommandResult> {
  const { config } = await loadConfig(repo);
  const registry = await AdapterRegistry.fromConfig(config.adapters);
  // Default resolve-only (no version spawn). Opt in with --probe.
  const matrix = await registry.healthMatrix({
    skip_version_probe: options.probe !== true,
  });

  let rows = matrix.adapters;
  if (options.enabledOnly) {
    rows = rows.filter((r) => r.enabled);
  }

  stdout.write("STATUS   ID           SOURCE         BINARY\n");
  stdout.write("-------- ------------ -------------- ------\n");
  for (const row of rows) {
    stdout.write(`${formatRow(row)}\n`);
  }
  stdout.write(
    `\n${matrix.healthy_count}/${matrix.adapters.length} healthy` +
      (matrix.has_healthy_coding_adapter
        ? "; coding adapter available\n"
        : "; no healthy coding adapter (shell only or unbound)\n"),
  );
  if (!options.probe) {
    stdout.write(
      "(resolve-only; pass --probe for live version checks, or use adapter test)\n",
    );
  }

  return { exitCode: 0, action: "list", matrix };
}

async function registerAdapter(
  repo: string,
  options: AdapterCommandOptions,
  stdout: NodeJS.WritableStream,
): Promise<AdapterCommandResult> {
  const id = options.id?.trim();
  if (!id) {
    throw new Error("adapter register requires --id <id>");
  }
  if (id === "shell") {
    throw new Error(
      'adapter id "shell" is reserved for the deterministic shell adapter; cannot register',
    );
  }
  const binary = options.binary?.trim();
  if (!binary) {
    throw new Error("adapter register requires --binary <path-or-name>");
  }

  const { config, configPath } = await loadConfig(repo);

  const builtinIds = new Set(["claude", "codex", "agy", "grok"]);
  const isBuiltin = builtinIds.has(id);

  let capabilities: AdapterRegistryEntry["capabilities"];
  if (options.capabilitiesJson) {
    try {
      capabilities = JSON.parse(
        options.capabilitiesJson,
      ) as AdapterRegistryEntry["capabilities"];
    } catch {
      throw new Error("--capabilities must be valid JSON");
    }
  }

  const entryInput: Record<string, unknown> = {
    id,
    binary,
    enabled: true,
    source: "user_config",
  };
  if (options.displayName) entryInput.display_name = options.displayName;
  if (options.startTemplate) entryInput.start_template = options.startTemplate;
  if (capabilities) entryInput.capabilities = capabilities;

  // Non-builtin without start_template cannot be started via createAdapter.
  if (!isBuiltin && !options.startTemplate) {
    stdout.write(
      `warn: no --start-template for "${id}"; adapter will be discoverable but not startable until a template is set\n`,
    );
  }

  const entry = AdapterRegistryEntrySchema.parse(entryInput);

  const registryEntries = [...config.adapters.registry];
  const idx = registryEntries.findIndex((r) => r.id === id);
  if (idx >= 0) {
    registryEntries[idx] = entry;
  } else {
    registryEntries.push(entry);
  }

  const next: LazyorchConfig = {
    ...config,
    adapters: {
      ...config.adapters,
      registry: registryEntries,
    },
  };

  const yaml = stringifyConfigYaml(next);
  await writeFile(
    configPath,
    yaml.endsWith("\n") ? yaml : `${yaml}\n`,
    "utf8",
  );

  const resolved = await AdapterRegistry.fromConfig(next.adapters);
  const reg = resolved.get(id);
  const canStart = Boolean(
    reg && reg.enabled && !reg.unbound && reg.start_template,
  );

  stdout.write(
    `registered adapter ${id} → ${binary}` +
      (reg?.binary_path
        ? ` (resolved: ${reg.binary_path})`
        : " (unbound until found on PATH)") +
      `\n      matrix.start=${canStart}` +
      (canStart ? "" : " (needs bound binary + start_template)") +
      `\nwrote ${configPath}\n`,
  );

  const result: AdapterCommandResult = {
    exitCode: 0,
    action: "register",
    configPath,
    message: `registered ${id}`,
  };
  if (reg) result.registration = reg;
  return result;
}

async function testAdapter(
  repo: string,
  options: AdapterCommandOptions,
  stdout: NodeJS.WritableStream,
): Promise<AdapterCommandResult> {
  const { config } = await loadConfig(repo);
  const registry = await AdapterRegistry.fromConfig(config.adapters);

  const id = options.id?.trim();
  if (id) {
    const reg = registry.get(id);
    if (!reg) {
      throw new Error(`unknown adapter id "${id}"`);
    }
    const results = await registry.doctor(id);
    const d = results[0];
    if (!d) {
      throw new Error(`no doctor result for ${id}`);
    }
    // Align with doctor: unbound is WARN (exit 0); hard probe errors fail.
    const classified = classifyProbeExit(d);
    stdout.write(
      `${classified.tag}  ${d.adapter_id}: ${d.message}` +
        (d.binary_path ? ` [${d.binary_path}]` : "") +
        (d.version ? ` version=${d.version}` : "") +
        "\n",
    );
    const matrix = await registry.healthMatrix();
    const row = matrix.adapters.find((a) => a.id === id);
    if (row) {
      stdout.write(
        `      matrix: doctor=${row.matrix.doctor} start=${row.matrix.start} cancel=${row.matrix.cancel} model_flag=${String(row.matrix.model_flag)} usage=${String(row.matrix.usage_parse)} worktree=${row.matrix.worktree_cwd}\n`,
      );
    }
    const out: AdapterCommandResult = {
      exitCode: classified.exitCode,
      action: "test",
      matrix,
      message: d.message,
    };
    out.registration = reg;
    return out;
  }

  const matrix = await registry.healthMatrix();
  let failed = 0;
  for (const row of matrix.adapters) {
    const tag =
      row.status === "ok"
        ? "ok  "
        : row.status === "disabled"
          ? "skip"
          : row.status === "unbound"
            ? "WARN"
            : "FAIL";
    stdout.write(`${tag}  ${formatRow(row)}\n`);
    if (row.status === "error") failed += 1;
  }
  stdout.write(
    `\ntest: ${matrix.healthy_count} ok, ${matrix.adapters.filter((a) => a.status === "unbound").length} unbound, ${failed} error(s)\n`,
  );
  return {
    exitCode: failed > 0 ? 1 : 0,
    action: "test",
    matrix,
  };
}
