import type { SchemaVersion } from "../schema.js";

/**
 * LazyOrch-managed workspace bound to a git repo root.
 * Conceptually project.yml under `<repo>/.lazyorch/`.
 */
export interface Project {
  schema_version: SchemaVersion;
  id: string;
  repo_root: string;
  name?: string;
  created_at: string;
  updated_at: string;
}
