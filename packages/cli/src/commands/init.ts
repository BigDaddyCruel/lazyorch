import { access, mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import {
  createDefaultConfig,
  stringifyConfigYaml,
} from "@lazyorch/shared";

/** Project entity schema version (mirrors @lazyorch/core SCHEMA_VERSION). */
const PROJECT_SCHEMA_VERSION = 1 as const;

export interface InitOptions {
  /** Target repository root (defaults to cwd). */
  repo?: string;
  /** Project display name (defaults to directory basename). */
  name?: string;
  /** Overwrite existing config.yml / project.json. */
  force?: boolean;
  /** Writable stream for status lines (defaults to process.stdout). */
  stdout?: NodeJS.WritableStream;
}

export interface InitResult {
  root: string;
  lazyorchDir: string;
  configPath: string;
  projectPath: string;
  projectId: string;
  created: string[];
  skipped: string[];
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function projectId(): string {
  return `proj_${randomBytes(12).toString("hex")}`;
}

/**
 * Create `.lazyorch/config.yml` and `project.json` skeleton in a repo root.
 */
export async function runInit(options: InitOptions = {}): Promise<InitResult> {
  const stdout = options.stdout ?? process.stdout;
  const root = resolve(options.repo ?? process.cwd());
  const name = options.name ?? basename(root);
  const force = options.force === true;

  const lazyorchDir = join(root, ".lazyorch");
  const configPath = join(lazyorchDir, "config.yml");
  const projectPath = join(lazyorchDir, "project.json");

  const created: string[] = [];
  const skipped: string[] = [];

  await mkdir(lazyorchDir, { recursive: true });

  // config.yml
  if ((await exists(configPath)) && !force) {
    skipped.push(configPath);
    stdout.write(`skip  ${configPath} (exists; use --force to overwrite)\n`);
  } else {
    const config = createDefaultConfig(name);
    const yaml = stringifyConfigYaml(config);
    await writeFile(configPath, yaml.endsWith("\n") ? yaml : `${yaml}\n`, "utf8");
    created.push(configPath);
    stdout.write(`wrote ${configPath}\n`);
  }

  // project.json
  let id = projectId();
  if ((await exists(projectPath)) && !force) {
    skipped.push(projectPath);
    stdout.write(`skip  ${projectPath} (exists; use --force to overwrite)\n`);
  } else {
    const now = new Date().toISOString();
    id = projectId();
    const project = {
      schema_version: PROJECT_SCHEMA_VERSION,
      id,
      repo_root: root,
      name,
      created_at: now,
      updated_at: now,
    };
    await writeFile(
      projectPath,
      `${JSON.stringify(project, null, 2)}\n`,
      "utf8",
    );
    created.push(projectPath);
    stdout.write(`wrote ${projectPath}\n`);
  }

  stdout.write(`lazyorch init complete in ${root}\n`);

  return {
    root,
    lazyorchDir,
    configPath,
    projectPath,
    projectId: id,
    created,
    skipped,
  };
}
