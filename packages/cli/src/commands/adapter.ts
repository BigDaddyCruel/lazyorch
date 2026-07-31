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
  /** Skip version exec (resolve-only). */
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

async function listAdapters(
  repo: string,
  options: AdapterCommandOptions,
  stdout: NodeJS.WritableStream,
): Promise<AdapterCommandResult> {
  const { config } = await loadConfig(repo);
  const registry = await AdapterRegistry.fromConfig(config.adapters);
  const matrix = await registry.healthMatrix({
    skip_version_probe: options.skipProbe === true,
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
  const binary = options.binary?.trim();
  if (!binary) {
    throw new Error("adapter register requires --binary <path-or-name>");
  }

  const { config, configPath } = await loadConfig(repo);

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

  stdout.write(
    `registered adapter ${id} → ${binary}` +
      (reg?.binary_path
        ? ` (resolved: ${reg.binary_path})`
        : " (unbound until found on PATH)") +
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
    const tag = d.ok ? "ok  " : "FAIL";
    stdout.write(
      `${tag}  ${d.adapter_id}: ${d.message}` +
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
      exitCode: d.ok ? 0 : 1,
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
    if (row.status === "error" || row.status === "missing") failed += 1;
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
