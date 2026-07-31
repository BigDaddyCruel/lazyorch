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

/**
 * Multi-project registry stored at `~/.lazyorch/projects.json`.
 * Maps project ids → absolute repo roots for the user-level daemon.
 */
export class ProjectRegistry {
  private readonly path: string;
  private readonly homeDir: string | undefined;

  constructor(homeDir?: string) {
    this.homeDir = homeDir;
    this.path = projectsRegistryPath(homeDir);
  }

  get filePath(): string {
    return this.path;
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
   * Identity is by absolute repo_root (id preserved on update when possible).
   */
  async register(input: {
    id: string;
    repo_root: string;
    name?: string;
  }): Promise<RegisteredProject> {
    const file = await this.load();
    const abs = resolve(input.repo_root);
    const key = normalizeRepoRoot(abs);
    const now = new Date().toISOString();
    const existingIdx = file.projects.findIndex(
      (p) => normalizeRepoRoot(p.repo_root) === key || p.id === input.id,
    );

    if (existingIdx >= 0) {
      const prev = file.projects[existingIdx]!;
      const updated: RegisteredProject = {
        id: prev.id,
        repo_root: abs,
        registered_at: prev.registered_at,
        updated_at: now,
      };
      if (input.name !== undefined) updated.name = input.name;
      else if (prev.name !== undefined) updated.name = prev.name;
      file.projects[existingIdx] = updated;
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
  }

  async unregister(idOrRoot: string): Promise<boolean> {
    const file = await this.load();
    const key = normalizeRepoRoot(idOrRoot);
    const before = file.projects.length;
    file.projects = file.projects.filter(
      (p) => p.id !== idOrRoot && normalizeRepoRoot(p.repo_root) !== key,
    );
    if (file.projects.length === before) return false;
    await this.save(file);
    return true;
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
