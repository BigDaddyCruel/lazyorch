import type { SchemaVersion } from "../schema.js";

/**
 * LazyOrch-managed workspace bound to a git repo root.
 * Persisted as `project.json` under `<repo>/.lazyorch/` (entity state is JSON;
 * operator config remains YAML, e.g. `config.yml`).
 */
export interface Project {
  schema_version: SchemaVersion;
  id: string;
  repo_root: string;
  name?: string;
  created_at: string;
  updated_at: string;
}
