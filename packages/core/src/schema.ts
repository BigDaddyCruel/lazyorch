/** Forward-only project/entity schema version (project.yml / entity JSON). */
export const SCHEMA_VERSION = 1 as const;

export type SchemaVersion = typeof SCHEMA_VERSION;
