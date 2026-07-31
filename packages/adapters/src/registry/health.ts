/**
 * Adapter health matrix — doctor-all + capability flags.
 */

import type { DoctorResult } from "../types.js";
import {
  getBuiltinCatalogEntry,
  isBuiltinAdapterId,
  matrixFlagsFor,
} from "./catalog.js";
import { probeAdapter, type ProbeOptions } from "./probe.js";
import type {
  AdapterHealthRow,
  AdapterHealthStatus,
  AdapterRegistration,
  HealthMatrix,
} from "./types.js";

export interface HealthOptions extends ProbeOptions {
  /** When true, skip version exec and only use resolve-time unbound/missing. */
  skip_version_probe?: boolean;
}

function statusFromDoctor(
  reg: AdapterRegistration,
  doctor: DoctorResult,
): AdapterHealthStatus {
  if (!reg.enabled) return "disabled";
  if (doctor.unbound || reg.unbound) return "unbound";
  if (!doctor.ok) return doctor.unbound ? "unbound" : "error";
  return "ok";
}

function kindFor(reg: AdapterRegistration): "llm" | "deterministic" | "generic" {
  if (reg.id === "shell") return "deterministic";
  const cat = getBuiltinCatalogEntry(reg.id);
  if (cat) return cat.kind;
  return "generic";
}

/**
 * Build one health row from a registration + optional doctor result.
 */
export function healthRowFrom(
  reg: AdapterRegistration,
  doctor?: DoctorResult,
): AdapterHealthRow {
  const d: DoctorResult = doctor ?? {
    ok: !reg.unbound && reg.enabled,
    adapter_id: reg.id,
    message: reg.unbound
      ? `adapter ${reg.id}: unbound`
      : reg.enabled
        ? `adapter ${reg.id}: not probed`
        : `adapter ${reg.id}: disabled`,
    ...(reg.unbound === true ? { unbound: true } : {}),
  };

  const status = statusFromDoctor(reg, d);
  const kind = kindFor(reg);
  // Runtime start available: shell always; generic when template + bound;
  // builtins have catalog templates (thin) when bound.
  const canStart =
    reg.id === "shell"
      ? reg.enabled
      : reg.enabled && !reg.unbound && Boolean(reg.start_template);

  const matrix = matrixFlagsFor(
    reg.id,
    isBuiltinAdapterId(reg.id) && reg.id !== "shell" ? "llm" : kind,
  );
  // Reflect actual availability in matrix.start
  matrix.start = canStart;
  matrix.doctor = true;

  const row: AdapterHealthRow = {
    id: reg.id,
    display_name: reg.display_name,
    enabled: reg.enabled,
    source: reg.source,
    status,
    message: d.message,
    capabilities: reg.capabilities,
    matrix,
  };
  if (reg.binary) row.binary = reg.binary;
  if (reg.binary_path) row.binary_path = reg.binary_path;
  else if (d.binary_path) row.binary_path = d.binary_path;
  if (d.version) row.version = d.version;
  if (reg.unbound || d.unbound) row.unbound = true;
  return row;
}

/**
 * Probe all registrations and build the health matrix.
 */
export async function buildHealthMatrix(
  registrations: readonly AdapterRegistration[],
  options: HealthOptions = {},
): Promise<HealthMatrix> {
  const adapters: AdapterHealthRow[] = [];

  for (const reg of registrations) {
    let doctor: DoctorResult;
    if (options.skip_version_probe) {
      doctor = {
        ok: reg.enabled && !reg.unbound,
        adapter_id: reg.id,
        message: reg.unbound
          ? `adapter ${reg.id}: unbound (binary not found)`
          : reg.enabled
            ? `adapter ${reg.id}: resolved (${reg.binary_path ?? reg.binary})`
            : `adapter ${reg.id}: disabled`,
        unbound: reg.unbound === true,
      };
      if (reg.binary_path) doctor.binary_path = reg.binary_path;
    } else {
      doctor = await probeAdapter(reg, options);
    }
    adapters.push(healthRowFrom(reg, doctor));
  }

  const enabled_count = adapters.filter((a) => a.enabled).length;
  const healthy_count = adapters.filter((a) => a.status === "ok").length;
  const has_healthy_coding_adapter = adapters.some(
    (a) => a.id !== "shell" && a.status === "ok" && a.enabled,
  );

  return {
    adapters,
    has_healthy_coding_adapter,
    enabled_count,
    healthy_count,
  };
}

/**
 * Doctor all adapters (or one id).
 */
export async function doctorAdapters(
  registrations: readonly AdapterRegistration[],
  options: HealthOptions & { id?: string } = {},
): Promise<DoctorResult[]> {
  const list = options.id
    ? registrations.filter((r) => r.id === options.id)
    : registrations;
  const results: DoctorResult[] = [];
  for (const reg of list) {
    if (options.skip_version_probe) {
      results.push({
        ok: reg.enabled && !reg.unbound,
        adapter_id: reg.id,
        message: reg.unbound
          ? `adapter ${reg.id}: unbound`
          : reg.enabled
            ? `adapter ${reg.id}: resolved`
            : `adapter ${reg.id}: disabled`,
        unbound: reg.unbound === true,
        ...(reg.binary_path ? { binary_path: reg.binary_path } : {}),
      });
    } else {
      results.push(await probeAdapter(reg, options));
    }
  }
  return results;
}
