import { describe, expect, it } from "vitest";
import {
  isModelTier,
  MODEL_TIERS,
  parseModelTier,
  type ModelTier,
} from "./model-tier.js";

describe("ModelTier", () => {
  it("lists the five design tiers", () => {
    expect(MODEL_TIERS).toEqual([
      "nano",
      "small",
      "medium",
      "large",
      "xlarge",
    ]);
  });

  it("type guard accepts valid tiers", () => {
    for (const t of MODEL_TIERS) {
      expect(isModelTier(t)).toBe(true);
      expect(parseModelTier(t)).toBe(t);
    }
  });

  it("type guard rejects invalid values", () => {
    expect(isModelTier("huge")).toBe(false);
    expect(isModelTier("NANO")).toBe(false);
    expect(isModelTier("")).toBe(false);
    expect(isModelTier(undefined)).toBe(false);
    expect(isModelTier(3)).toBe(false);
    expect(parseModelTier("huge")).toBeNull();
  });

  it("can be used as tier_override on tasks (type-level smoke)", () => {
    const tier: ModelTier = "large";
    expect(isModelTier(tier)).toBe(true);
  });
});
