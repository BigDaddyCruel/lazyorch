import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { SCHEMA_VERSION } from "@lazyorch/shared";
import { projectsRegistryPath, userLazyorchDir } from "./paths.js";

/** Absolute repo root key stable across Windows path casing/separators. */
export function normalizeRepoRoot(repoRoot: string): string {
  const abs = resolve(repoRoot);
  if (process.platform === "win32") {
    return abs.replace(/\\/g, "/").toLowerCase();
  }
  return abs;
}

export interface RegisteredProject {
  id: string;
  repo_root: string;
  name?: string;
  registered_at: string;
  updated_at: string;
}

export interface ProjectRegistryFile {
  schema_version: number;
  projects: RegisteredProject[];
}

export class RegistryConflictError extends Error {
  readonly code = "registry_conflict" as const;

  constructor(message: string) {
    super(message);
    this.name = "RegistryConflictError";
  }
}

/**
 * Multi-project registry stored at `~/.lazyorch/projects.json`.
 * Maps project ids → absolute repo roots for the user-level daemon.
 *
 * Mutations are serialized in-process. Unique `id` and unique
 * `normalizeRepoRoot(repo_root)` are enforced.
 */
export class ProjectRegistry {
  private readonly path: string;
  private readonly homeDir: string | undefined;
  /** In-process mutex chain for load-mutate-save. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(homeDir?: string) {
    this.homeDir = homeDir;
    this.path = projectsRegistryPath(homeDir);
  }

  get filePath(): string {
    return this.path;
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>((r) => {
      release = r;
    });
    await prev.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async load(): Promise<ProjectRegistryFile> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as Partial<ProjectRegistryFile>;
      const projects = Array.isArray(parsed.projects)
        ? parsed.projects.filter(isRegisteredProject)
        : [];
      return {
        schema_version:
          typeof parsed.schema_version === "number"
            ? parsed.schema_version
            : SCHEMA_VERSION,
        projects,
      };
    } catch (err) {
      if (isNotFound(err)) {
        return { schema_version: SCHEMA_VERSION, projects: [] };
      }
      throw err;
    }
  }

  async save(file: ProjectRegistryFile): Promise<void> {
    const dir = userLazyorchDir(this.homeDir);
    await mkdir(dir, { recursive: true });
    const body = `${JSON.stringify(file, null, 2)}\n`;
    const tmp = join(dirname(this.path), `.${randomBytes(8).toString("hex")}.tmp`);
    try {
      await writeFile(tmp, body, "utf8");
      await rename(tmp, this.path);
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
  }

  async list(): Promise<RegisteredProject[]> {
    const file = await this.load();
    return file.projects;
  }

  async getById(id: string): Promise<RegisteredProject | null> {
    const projects = await this.list();
    return projects.find((p) => p.id === id) ?? null;
  }

  async getByRoot(repoRoot: string): Promise<RegisteredProject | null> {
    const key = normalizeRepoRoot(repoRoot);
    const projects = await this.list();
    return (
      projects.find((p) => normalizeRepoRoot(p.repo_root) === key) ?? null
    );
  }

  /**
   * Register or update a project root.
   * - Same id + same root (or free root): update in place.
   * - Same root, different id: reject (root already registered).
   * - Same id, different root: rebind only if new root is free.
   * - Cross match (id→A, root→B different entries): reject.
   */
  async register(input: {
    id: string;
    repo_root: string;
    name?: string;
  }): Promise<RegisteredProject> {
    return this.withLock(async () => {
      const file = await this.load();
      const abs = resolve(input.repo_root);
      const key = normalizeRepoRoot(abs);
      const now = new Date().toISOString();

      const byRoot = file.projects.findIndex(
        (p) => normalizeRepoRoot(p.repo_root) === key,
      );
      const byId = file.projects.findIndex((p) => p.id === input.id);

      // Cross-match: id points at entry A, root at entry B → refuse (would duplicate root)
      if (byRoot >= 0 && byId >= 0 && byRoot !== byId) {
        throw new RegistryConflictError(
          `Project id '${input.id}' and repo_root '${abs}' refer to different registry entries`,
        );
      }

      if (byRoot >= 0) {
        // Root is identity: update that entry; keep existing id (ignore mismatched id)
        const prev = file.projects[byRoot]!;
        const updated: RegisteredProject = {
          id: prev.id,
          repo_root: abs,
          registered_at: prev.registered_at,
          updated_at: now,
        };
        if (input.name !== undefined) updated.name = input.name;
        else if (prev.name !== undefined) updated.name = prev.name;
        file.projects[byRoot] = updated;
        await this.save(file);
        return updated;
      }

      if (byId >= 0) {
        // Rebind existing id to a new free root (root not claimed)
        const prev = file.projects[byId]!;
        const updated: RegisteredProject = {
          id: prev.id,
          repo_root: abs,
          registered_at: prev.registered_at,
          updated_at: now,
        };
        if (input.name !== undefined) updated.name = input.name;
        else if (prev.name !== undefined) updated.name = prev.name;
        file.projects[byId] = updated;
        await this.save(file);
        return updated;
      }

      const entry: RegisteredProject = {
        id: input.id,
        repo_root: abs,
        registered_at: now,
        updated_at: now,
      };
      if (input.name !== undefined) entry.name = input.name;
      file.projects.push(entry);
      await this.save(file);
      return entry;
    });
  }

  async unregister(idOrRoot: string): Promise<boolean> {
    return this.withLock(async () => {
      const file = await this.load();
      const before = file.projects.length;
      // Prefer id match; only treat as root when it looks like a path or matches a root
      const byId = file.projects.filter((p) => p.id === idOrRoot);
      if (byId.length > 0) {
        file.projects = file.projects.filter((p) => p.id !== idOrRoot);
      } else {
        const key = normalizeRepoRoot(idOrRoot);
        file.projects = file.projects.filter(
          (p) => normalizeRepoRoot(p.repo_root) !== key,
        );
      }
      if (file.projects.length === before) return false;
      await this.save(file);
      return true;
    });
  }
}

function isRegisteredProject(v: unknown): v is RegisteredProject {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.repo_root === "string" &&
    typeof o.registered_at === "string" &&
    typeof o.updated_at === "string"
  );
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}
