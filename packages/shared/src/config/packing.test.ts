import { describe, expect, it } from "vitest";
import {
  minSlotDemand,
  peakSlotDemand,
  validateSlotPacking,
} from "./packing.js";

describe("slot packing", () => {
  it("accepts design defaults min pack (1+4+1+1 ≤ 8) with peak warn (1+4+2+2=9)", () => {
    const result = validateSlotPacking({
      max_concurrent_agents: 8,
      max_workers: 4,
      reserve_slots_lead: 1,
      min_reviewers: 1,
      min_qa: 1,
      max_reviewers: 2,
      max_qa: 2,
    });
    expect(result.ok).toBe(true);
    expect(result.minRequired).toBe(7);
    expect(result.peakRequired).toBe(9); // 1+4+2+2
    expect(result.errors).toEqual([]);
    // Design defaults warn on peak contention (KD packing soft invariant)
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/slot packing peak/);
  });

  it("is fully clean when peak also fits", () => {
    const result = validateSlotPacking({
      max_concurrent_agents: 10,
      max_workers: 4,
      reserve_slots_lead: 1,
      min_reviewers: 1,
      min_qa: 1,
      max_reviewers: 2,
      max_qa: 2,
    });
    expect(result.ok).toBe(true);
    expect(result.peakRequired).toBe(9);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("errors when min team cannot pack under ceiling", () => {
    const result = validateSlotPacking({
      max_concurrent_agents: 5,
      max_workers: 4,
      reserve_slots_lead: 1,
      min_reviewers: 1,
      min_qa: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.minRequired).toBe(7);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/slot packing/);
    expect(result.errors[0]).toMatch(/> max_concurrent_agents \(5\)/);
  });

  it("warns when peak packing exceeds ceiling but min fits", () => {
    const result = validateSlotPacking({
      max_concurrent_agents: 7,
      max_workers: 4,
      reserve_slots_lead: 1,
      min_reviewers: 1,
      min_qa: 1,
      max_reviewers: 2,
      max_qa: 2,
    });
    expect(result.ok).toBe(true);
    expect(result.minRequired).toBe(7);
    expect(result.peakRequired).toBe(9);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/slot packing peak/);
  });

  it("computes min and peak demand helpers", () => {
    const input = {
      max_concurrent_agents: 8,
      max_workers: 4,
      reserve_slots_lead: 1,
      min_reviewers: 1,
      min_qa: 1,
      max_reviewers: 3,
      max_qa: 2,
    };
    expect(minSlotDemand(input)).toBe(7);
    expect(peakSlotDemand(input)).toBe(10);
  });

  it("falls back peak max to min when max omitted", () => {
    expect(
      peakSlotDemand({
        max_concurrent_agents: 8,
        max_workers: 2,
        reserve_slots_lead: 1,
        min_reviewers: 1,
        min_qa: 1,
      }),
    ).toBe(5);
  });
});
