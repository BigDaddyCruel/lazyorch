/**
 * AdapterRegistry — discover, list, doctor, create runtime adapters.
 */

import type { AdaptersConfig } from "@lazyorch/shared";
import {
  createShellAdapter,
  type ShellAdapter,
  type ShellAdapterOptions,
  type SpawnImpl,
} from "../shell/adapter.js";
import type { AgentAdapter } from "../types.js";
import { createGenericAdapter, type GenericCliAdapter } from "./generic.js";
import {
  buildHealthMatrix,
  doctorAdapters,
  type HealthOptions,
} from "./health.js";
import type { ExecImpl } from "./probe.js";
import {
  resolveAdapterRegistrations,
  type ResolveRegistryOptions,
} from "./resolve.js";
import type {
  AdapterRegistration,
  HealthMatrix,
} from "./types.js";
import type { DoctorResult } from "../types.js";

export interface AdapterRegistryOptions extends ResolveRegistryOptions {
  /** Injected spawn for generic/shell adapters in tests. */
  spawnImpl?: SpawnImpl;
  /** Injected version exec for probes. */
  execImpl?: ExecImpl;
  shell?: ShellAdapterOptions;
}

export class AdapterRegistry {
  private registrations: AdapterRegistration[] = [];
  private readonly options: AdapterRegistryOptions;
  private shellAdapter: ShellAdapter | null = null;

  private constructor(
    registrations: AdapterRegistration[],
    options: AdapterRegistryOptions,
  ) {
    this.registrations = registrations;
    this.options = options;
  }

  /**
   * Build registry from adapters config (PATH discovery + user registry[]).
   */
  static async fromConfig(
    config: AdaptersConfig,
    options: AdapterRegistryOptions = {},
  ): Promise<AdapterRegistry> {
    const registrations = await resolveAdapterRegistrations(config, options);
    return new AdapterRegistry(registrations, options);
  }

  /** Construct from pre-resolved registrations (tests / daemon cache). */
  static fromRegistrations(
    registrations: AdapterRegistration[],
    options: AdapterRegistryOptions = {},
  ): AdapterRegistry {
    return new AdapterRegistry([...registrations], options);
  }

  list(options: { enabledOnly?: boolean } = {}): AdapterRegistration[] {
    if (options.enabledOnly) {
      return this.registrations.filter((r) => r.enabled);
    }
    return [...this.registrations];
  }

  get(id: string): AdapterRegistration | undefined {
    return this.registrations.find((r) => r.id === id);
  }

  has(id: string): boolean {
    return this.registrations.some((r) => r.id === id);
  }

  /**
   * Replace or append a registration (in-memory; persist via CLI register).
   */
  upsert(reg: AdapterRegistration): void {
    const idx = this.registrations.findIndex((r) => r.id === reg.id);
    if (idx >= 0) {
      this.registrations[idx] = reg;
    } else {
      this.registrations.push(reg);
    }
  }

  async doctor(id?: string): Promise<DoctorResult[]> {
    const probe: HealthOptions = {};
    if (this.options.execImpl) probe.exec = this.options.execImpl;
    if (id !== undefined) {
      return doctorAdapters(this.registrations, { ...probe, id });
    }
    return doctorAdapters(this.registrations, probe);
  }

  async healthMatrix(
    options: HealthOptions = {},
  ): Promise<HealthMatrix> {
    const merged: HealthOptions = { ...options };
    if (this.options.execImpl && !merged.exec) {
      merged.exec = this.options.execImpl;
    }
    return buildHealthMatrix(this.registrations, merged);
  }

  /**
   * Create a runtime AgentAdapter.
   * - shell → ShellAdapter (always; ignores registry overlays)
   * - others with start_template → GenericCliAdapter (thin; PR-09 deepens builtins)
   * - unbound / no template → null
   */
  createAdapter(id: string): AgentAdapter | null {
    // Shell is hard-wired: never GenericCliAdapter, never null due to overlay.
    if (id === "shell") {
      const reg = this.get("shell");
      if (reg && !reg.enabled) return null;
      if (!this.shellAdapter) {
        const shellOpts: ShellAdapterOptions = {
          ...(this.options.shell ?? {}),
        };
        if (this.options.spawnImpl) shellOpts.spawnImpl = this.options.spawnImpl;
        this.shellAdapter = createShellAdapter(shellOpts);
      }
      return this.shellAdapter;
    }

    const reg = this.get(id);
    if (!reg || !reg.enabled) return null;

    if (reg.unbound) return null;
    if (!reg.start_template) return null;

    const genOpts: {
      spawnImpl?: SpawnImpl;
      execImpl?: ExecImpl;
    } = {};
    if (this.options.spawnImpl) genOpts.spawnImpl = this.options.spawnImpl;
    if (this.options.execImpl) genOpts.execImpl = this.options.execImpl;
    return createGenericAdapter(reg, genOpts);
  }

  /**
   * Prefer createAdapter; returns typed generic when applicable.
   */
  createGeneric(id: string): GenericCliAdapter | null {
    const adapter = this.createAdapter(id);
    if (adapter && adapter.id !== "shell") {
      return adapter as GenericCliAdapter;
    }
    return null;
  }
}

export async function createAdapterRegistry(
  config: AdaptersConfig,
  options?: AdapterRegistryOptions,
): Promise<AdapterRegistry> {
  return AdapterRegistry.fromConfig(config, options);
}
