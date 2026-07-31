/** Forward-only project/entity schema version (project.json / entity JSON). */
export const SCHEMA_VERSION = 1 as const;

export type SchemaVersion = typeof SCHEMA_VERSION;
