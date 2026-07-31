/**
 * Version / health probe for adapter binaries.
 * Injectable exec for unit tests (no real CLI required).
 */

import { spawn } from "node:child_process";
import type { DoctorResult } from "../types.js";
import type { AdapterRegistration } from "./types.js";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type ExecImpl = (
  binary: string,
  args: readonly string[],
  options?: { timeout_ms?: number },
) => Promise<ExecResult>;

export interface ProbeOptions {
  exec?: ExecImpl;
  /** Max time for version probe (default 5s). */
  timeout_ms?: number;
}

/**
 * Default spawn-based exec. Captures stdout/stderr; kills on timeout.
 */
export function defaultExecImpl(
  binary: string,
  args: readonly string[],
  options: { timeout_ms?: number } = {},
): Promise<ExecResult> {
  const timeout_ms = options.timeout_ms ?? 5_000;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ExecResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child;
    try {
      child = spawn(binary, [...args], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
    } catch (err) {
      finish({
        code: 1,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer | string) => {
      stdout += typeof c === "string" ? c : c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer | string) => {
      stderr += typeof c === "string" ? c : c.toString("utf8");
    });

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      finish({
        code: null,
        stdout,
        stderr: stderr || "version probe timed out",
      });
    }, timeout_ms);

    child.on("error", (err) => {
      clearTimeout(timer);
      finish({ code: 1, stdout, stderr: err.message });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      finish({ code, stdout, stderr });
    });
  });
}

/** Best-effort semver-ish token from version stdout. */
export function parseVersionString(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  // Prefer first x.y / x.y.z token (optional leading v)
  const m = trimmed.match(
    /\bv?(\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.]+)?)\b/i,
  );
  if (m?.[1]) return m[1];
  // Fall back to first non-empty line (truncated)
  const line = trimmed.split(/\r?\n/).find((l) => l.trim().length > 0);
  if (!line) return undefined;
  return line.trim().slice(0, 80);
}

/**
 * Compare simple dotted versions (version_floor). Non-semver → skip check.
 * Returns true if actual >= floor (best-effort).
 */
export function versionMeetsFloor(
  actual: string | undefined,
  floor: string | undefined,
): boolean {
  if (!floor) return true;
  if (!actual) return false;
  const parse = (v: string): number[] | null => {
    const m = v.trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    if (!m) return null;
    return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
  };
  const a = parse(actual);
  const f = parse(floor);
  if (!a || !f) return true; // non-parseable → do not fail closed
  for (let i = 0; i < 3; i++) {
    const av = a[i] ?? 0;
    const fv = f[i] ?? 0;
    if (av > fv) return true;
    if (av < fv) return false;
  }
  return true;
}

/**
 * Probe an adapter registration: binary present + optional --version.
 * Shell short-circuits as always ok.
 */
export async function probeAdapter(
  reg: AdapterRegistration,
  options: ProbeOptions = {},
): Promise<DoctorResult> {
  if (!reg.enabled) {
    return {
      ok: true,
      adapter_id: reg.id,
      message: `adapter ${reg.id}: disabled`,
      capabilities_probe: capsProbe(reg),
    };
  }

  if (reg.id === "shell" || reg.binary === "shell") {
    return {
      ok: true,
      adapter_id: reg.id,
      binary_path: "shell",
      message:
        "shell adapter ready (deterministic sessions; OS process spawn; no model tiers)",
      capabilities_probe: capsProbe(reg),
    };
  }

  if (reg.unbound || !reg.binary || reg.binary === "") {
    return {
      ok: false,
      adapter_id: reg.id,
      unbound: true,
      message: `adapter ${reg.id}: unbound (no binary on PATH; set adapters.${reg.id}.binary or adapters.registry entry)`,
      capabilities_probe: capsProbe(reg),
    };
  }

  const exec = options.exec ?? defaultExecImpl;
  const timeout_ms = options.timeout_ms ?? 5_000;
  const versionArgs = reg.version_args ?? ["--version"];
  const binary = reg.binary_path ?? reg.binary;

  try {
    const result = await exec(binary, versionArgs, { timeout_ms });
    const version = parseVersionString(result.stdout || result.stderr);

    if (result.code !== 0 && result.code !== null) {
      // Some CLIs exit non-zero on --version but still print useful text.
      if (!version) {
        return {
          ok: false,
          adapter_id: reg.id,
          binary_path: reg.binary_path ?? binary,
          message: `adapter ${reg.id}: version probe failed (exit ${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 200) || "no output"}`,
          capabilities_probe: capsProbe(reg),
        };
      }
    }

    if (
      reg.version_floor &&
      version &&
      !versionMeetsFloor(version, reg.version_floor)
    ) {
      return {
        ok: false,
        adapter_id: reg.id,
        binary_path: reg.binary_path ?? binary,
        version,
        message: `adapter ${reg.id}: version ${version} below floor ${reg.version_floor}`,
        capabilities_probe: capsProbe(reg),
      };
    }

    const out: DoctorResult = {
      ok: true,
      adapter_id: reg.id,
      binary_path: reg.binary_path ?? binary,
      message: version
        ? `adapter ${reg.id}: ok (${binary}, ${version})`
        : `adapter ${reg.id}: ok (${binary})`,
      capabilities_probe: capsProbe(reg),
    };
    if (version) out.version = version;
    return out;
  } catch (err) {
    return {
      ok: false,
      adapter_id: reg.id,
      binary_path: reg.binary_path ?? binary,
      message: `adapter ${reg.id}: probe error: ${err instanceof Error ? err.message : String(err)}`,
      capabilities_probe: capsProbe(reg),
    };
  }
}

function capsProbe(
  reg: AdapterRegistration,
): Record<string, unknown> {
  return {
    models: reg.capabilities.models,
    tier_map: reg.capabilities.tier_map,
    streaming: reg.capabilities.streaming,
    worktree_ok: reg.capabilities.worktree_ok,
    usage_reporting: reg.capabilities.usage_reporting,
    ...(reg.capabilities.effort_flag !== undefined
      ? { effort_flag: reg.capabilities.effort_flag }
      : {}),
  };
}
