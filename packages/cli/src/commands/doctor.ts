import { access, constants, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  ConfigValidationError,
  parseConfigYaml,
  type LazyorchConfig,
} from "@lazyorch/shared";

export interface DoctorOptions {
  /** Project root (defaults to cwd). */
  repo?: string;
  /** Treat as CI/headless for timeout_action defaults. */
  ci?: boolean;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

export type DoctorLevel = "ok" | "warn" | "error";

export interface DoctorFinding {
  level: DoctorLevel;
  code: string;
  message: string;
}

export interface DoctorResult {
  ok: boolean;
  exitCode: number;
  findings: DoctorFinding[];
  config: LazyorchConfig | null;
}

const BUILTIN_ADAPTERS = ["claude", "codex", "agy", "grok"] as const;

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort PATH binary check (no spawn). Missing binaries are warnings only.
 */
async function binaryResolvable(name: string): Promise<boolean> {
  if (!name) return false;

  // Absolute or relative path — check filesystem directly.
  if (name.includes("/") || name.includes("\\") || name.includes(":")) {
    try {
      await access(name, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  const pathEnv = process.env.PATH ?? process.env.Path ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];

  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    const base = join(dir, name);
    const candidates =
      process.platform === "win32"
        ? [base, ...exts.map((ext) => base + ext)]
        : [base];
    for (const p of candidates) {
      try {
        await access(p, constants.F_OK);
        return true;
      } catch {
        // try next
      }
    }
  }
  return false;
}

function isCi(options: DoctorOptions): boolean {
  if (options.ci === true) return true;
  if (options.ci === false) return false;
  const env = process.env.CI ?? process.env.GITHUB_ACTIONS;
  return env === "true" || env === "1";
}

/**
 * Validate project config and environment. Slot packing errors fail;
 * missing adapter binaries are warnings only.
 */
export async function runDoctor(
  options: DoctorOptions = {},
): Promise<DoctorResult> {
  const stdout = options.stdout ?? process.stdout;
  const findings: DoctorFinding[] = [];
  const root = resolve(options.repo ?? process.cwd());
  const lazyorchDir = join(root, ".lazyorch");
  const configPath = join(lazyorchDir, "config.yml");
  const projectPath = join(lazyorchDir, "project.json");
  const ci = isCi(options);

  let config: LazyorchConfig | null = null;

  // Presence of .lazyorch
  if (!(await pathExists(lazyorchDir))) {
    findings.push({
      level: "error",
      code: "no_lazyorch_dir",
      message: `missing ${lazyorchDir} — run \`lazyorch init\` first`,
    });
  } else {
    findings.push({
      level: "ok",
      code: "lazyorch_dir",
      message: `.lazyorch present at ${lazyorchDir}`,
    });
  }

  // project.json
  if (!(await pathExists(projectPath))) {
    findings.push({
      level: "error",
      code: "no_project_json",
      message: `missing ${projectPath}`,
    });
  } else {
    try {
      const raw = await readFile(projectPath, "utf8");
      const proj = JSON.parse(raw) as { schema_version?: unknown; id?: unknown };
      if (typeof proj.schema_version !== "number") {
        findings.push({
          level: "warn",
          code: "project_schema",
          message: "project.json missing schema_version",
        });
      } else {
        findings.push({
          level: "ok",
          code: "project_json",
          message: `project.json ok (schema_version=${proj.schema_version})`,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      findings.push({
        level: "error",
        code: "project_json_invalid",
        message: `project.json unreadable: ${msg}`,
      });
    }
  }

  // config.yml
  if (!(await pathExists(configPath))) {
    findings.push({
      level: "error",
      code: "no_config",
      message: `missing ${configPath}`,
    });
  } else {
    try {
      const yamlText = await readFile(configPath, "utf8");
      // Parse without enforcePacking first so we can report packing as structured findings
      const result = parseConfigYaml(yamlText, {
        ci,
        enforcePacking: false,
      });
      config = result.config;

      findings.push({
        level: "ok",
        code: "config_schema",
        message: "config.yml schema valid",
      });

      for (const w of result.warnings) {
        findings.push({ level: "warn", code: "config_warn", message: w });
      }

      if (!result.packing.ok) {
        for (const e of result.packing.errors) {
          findings.push({
            level: "error",
            code: "slot_packing",
            message: e,
          });
        }
      } else {
        findings.push({
          level: "ok",
          code: "slot_packing",
          message: `slot packing ok (min ${result.packing.minRequired} ≤ max_concurrent_agents ${result.packing.maxConcurrentAgents})`,
        });
      }

      if (ci && config.gates.timeout_action === "none") {
        findings.push({
          level: "warn",
          code: "ci_timeout",
          message:
            "CI detected and gates.timeout_action is none; design recommends fail for headless/CI (KD-44)",
        });
      }

      // Adapter binary checks — missing is warning only
      await checkAdapters(config, findings);
    } catch (err) {
      if (err instanceof ConfigValidationError) {
        for (const issue of err.issues) {
          findings.push({
            level: "error",
            code: "config_invalid",
            message: issue,
          });
        }
        if (err.issues.length === 0) {
          findings.push({
            level: "error",
            code: "config_invalid",
            message: err.message,
          });
        }
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        findings.push({
          level: "error",
          code: "config_read",
          message: msg,
        });
      }
    }
  }

  // Report
  let errors = 0;
  let warns = 0;
  for (const f of findings) {
    const tag =
      f.level === "ok" ? "ok  " : f.level === "warn" ? "WARN" : "FAIL";
    stdout.write(`${tag}  [${f.code}] ${f.message}\n`);
    if (f.level === "error") errors += 1;
    if (f.level === "warn") warns += 1;
  }

  const ok = errors === 0;
  stdout.write(
    ok
      ? `\ndoctor: ${findings.length} checks, ${warns} warning(s) — healthy\n`
      : `\ndoctor: ${errors} error(s), ${warns} warning(s) — unhealthy\n`,
  );

  return {
    ok,
    exitCode: ok ? 0 : 1,
    findings,
    config,
  };
}

async function checkAdapters(
  config: LazyorchConfig,
  findings: DoctorFinding[],
): Promise<void> {
  for (const id of BUILTIN_ADAPTERS) {
    const entry = config.adapters[id];
    if (!entry.enabled) {
      findings.push({
        level: "ok",
        code: `adapter_${id}`,
        message: `adapter ${id}: disabled`,
      });
      continue;
    }

    const candidates: string[] = [];
    if (entry.binary) candidates.push(entry.binary);
    if ("candidates" in entry && Array.isArray(entry.candidates)) {
      candidates.push(...entry.candidates);
    }
    if (candidates.length === 0) candidates.push(id);

    let found: string | null = null;
    for (const c of candidates) {
      if (await binaryResolvable(c)) {
        found = c;
        break;
      }
    }

    if (found) {
      findings.push({
        level: "ok",
        code: `adapter_${id}`,
        message: `adapter ${id}: found (${found})`,
      });
    } else {
      findings.push({
        level: "warn",
        code: `adapter_${id}_missing`,
        message: `adapter ${id}: binary not found on PATH (candidates: ${candidates.join(", ")}); ok until a run needs it`,
      });
    }
  }

  if (config.adapters.shell.enabled) {
    findings.push({
      level: "ok",
      code: "adapter_shell",
      message: "adapter shell: enabled (no external binary)",
    });
  }

  for (const reg of config.adapters.registry) {
    if (!reg.enabled) {
      findings.push({
        level: "ok",
        code: `adapter_${reg.id}`,
        message: `adapter ${reg.id}: disabled (registry)`,
      });
      continue;
    }
    const candidates = [
      ...(reg.binary ? [reg.binary] : []),
      ...(reg.candidates ?? []),
      reg.id,
    ];
    let found: string | null = null;
    for (const c of candidates) {
      if (await binaryResolvable(c)) {
        found = c;
        break;
      }
    }
    if (found) {
      findings.push({
        level: "ok",
        code: `adapter_${reg.id}`,
        message: `adapter ${reg.id}: found (${found})`,
      });
    } else {
      findings.push({
        level: "warn",
        code: `adapter_${reg.id}_missing`,
        message: `adapter ${reg.id}: binary not found (registry); ok until a run needs it`,
      });
    }
  }
}
