import { describe, expect, it } from "vitest";
import {
  generateId,
  ID_PREFIXES,
  isPrefixedId,
  parseIdPrefix,
  type IdPrefix,
} from "./ids.js";

describe("generateId", () => {
  it("uses the expected prefix for every IdPrefix", () => {
    for (const prefix of ID_PREFIXES) {
      const id = generateId(prefix);
      expect(id.startsWith(`${prefix}_`)).toBe(true);
      expect(isPrefixedId(id, prefix)).toBe(true);
      expect(parseIdPrefix(id)).toBe(prefix);
    }
  });

  it("produces unique ids", () => {
    const n = 200;
    const seen = new Set<string>();
    for (let i = 0; i < n; i++) {
      seen.add(generateId("run"));
    }
    expect(seen.size).toBe(n);
  });

  it("suffix is hex of length 24", () => {
    const id = generateId("tsk");
    const suffix = id.slice("tsk_".length);
    expect(suffix).toMatch(/^[0-9a-f]{24}$/);
  });
});

describe("isPrefixedId / parseIdPrefix", () => {
  it("rejects bare or empty suffixes", () => {
    expect(isPrefixedId("run_")).toBe(false);
    expect(isPrefixedId("run")).toBe(false);
    expect(isPrefixedId("")).toBe(false);
    expect(isPrefixedId("foo_bar")).toBe(false);
    expect(parseIdPrefix("foo_bar")).toBeNull();
  });

  it("optionally checks a specific prefix", () => {
    const id = generateId("gate");
    expect(isPrefixedId(id, "gate")).toBe(true);
    expect(isPrefixedId(id, "run" as IdPrefix)).toBe(false);
  });
});
