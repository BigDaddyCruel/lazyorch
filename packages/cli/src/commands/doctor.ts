import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AdapterRegistry } from "@lazyorch/adapters";
import {
  ConfigValidationError,
  parseConfigYaml,
  type LazyorchConfig,
} from "@lazyorch/shared";

export interface DoctorOptions {
  /** Project root (defaults to cwd). */
  repo?: string;
  /**
   * Treat as CI/headless for timeout_action defaults.
   * When omitted, auto-detects from CI/GITHUB_ACTIONS env.
   * Pass `false` (`--no-ci`) to force interactive semantics even under CI env.
   */
  ci?: boolean;
  stdout?: NodeJS.WritableStream;
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
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
      const proj = JSON.parse(raw) as {
        schema_version?: unknown;
        id?: unknown;
        repo_root?: unknown;
        name?: unknown;
      };
      const issues: string[] = [];
      if (typeof proj.schema_version !== "number") {
        issues.push("missing or non-number schema_version");
      }
      if (typeof proj.id !== "string" || proj.id.length === 0) {
        issues.push("missing or empty id");
      }
      if (typeof proj.repo_root !== "string" || proj.repo_root.length === 0) {
        issues.push("missing or empty repo_root");
      }
      if (issues.length > 0) {
        findings.push({
          level: "error",
          code: "project_json_invalid",
          message: `project.json incomplete: ${issues.join("; ")}`,
        });
      } else {
        findings.push({
          level: "ok",
          code: "project_json",
          message: `project.json ok (schema_version=${String(proj.schema_version)}, id=${String(proj.id)})`,
        });
        // Soft warn if repo_root does not match doctor --repo root
        const recorded = resolve(String(proj.repo_root));
        if (recorded !== root) {
          findings.push({
            level: "warn",
            code: "project_repo_root_mismatch",
            message: `project.json repo_root (${recorded}) ≠ doctor root (${root})`,
          });
        }
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

/**
 * Adapter checks via AdapterRegistry (PATH discovery + capability matrix).
 * Missing / unbound coding adapters are warnings only (doctor stays green).
 */
async function checkAdapters(
  config: LazyorchConfig,
  findings: DoctorFinding[],
): Promise<void> {
  const registry = await AdapterRegistry.fromConfig(config.adapters);
  // Resolve-only probe: avoid spawning unknown CLIs during doctor.
  const matrix = await registry.healthMatrix({ skip_version_probe: true });

  for (const row of matrix.adapters) {
    if (!row.enabled) {
      findings.push({
        level: "ok",
        code: `adapter_${row.id}`,
        message: `adapter ${row.id}: disabled`,
      });
      continue;
    }

    if (row.id === "shell") {
      findings.push({
        level: "ok",
        code: "adapter_shell",
        message: "adapter shell: enabled (no external binary)",
      });
      continue;
    }

    if (row.status === "ok") {
      findings.push({
        level: "ok",
        code: `adapter_${row.id}`,
        message: `adapter ${row.id}: found (${row.binary_path ?? row.binary ?? "?"})`,
      });
    } else if (row.status === "unbound") {
      findings.push({
        level: "warn",
        code: `adapter_${row.id}_missing`,
        message: `adapter ${row.id}: binary not found on PATH; ok until a run needs it`,
      });
    } else {
      findings.push({
        level: "warn",
        code: `adapter_${row.id}`,
        message: row.message,
      });
    }
  }

  if (!matrix.has_healthy_coding_adapter) {
    findings.push({
      level: "warn",
      code: "no_coding_adapter",
      message:
        "no healthy non-shell coding adapter bound; install claude/codex/agy/grok or register a CLI before LLM runs",
    });
  }
}
