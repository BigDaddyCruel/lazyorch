/**
 * @lazyorch/shared — logging, ids, config schemas (zod).
 */
export const PACKAGE_NAME = "@lazyorch/shared" as const;

export function sharedPlaceholder(): string {
  return PACKAGE_NAME;
}

export {
  generateId,
  ID_PREFIXES,
  isPrefixedId,
  parseIdPrefix,
  type IdPrefix,
} from "./ids.js";
