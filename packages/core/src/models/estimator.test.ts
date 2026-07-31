import { describe, expect, it } from "vitest";
import {
  clampScore,
  estimateComplexity,
  locBucket,
  normalizeSignals,
  planTierSoftPrior,
  roleBase,
  securityRiskHit,
} from "./estimator.js";
import {
  DEFAULT_COMPLEXITY_WEIGHTS,
  DEFAULT_SCORE_BANDS,
  TIER_BAND_MIDPOINT,
} from "./defaults.js";
import { scoreToTier } from "./tiers.js";
import type { ComplexitySignals } from "./types.js";

function baseSignals(
  overrides: Partial<ComplexitySignals> = {},
): ComplexitySignals {
  return normalizeSignals({
    role: "worker",
    ...overrides,
  });
}

describe("score bands (stable contract)", () => {
  it("maps inclusive band edges to the correct tier", () => {
    expect(scoreToTier(0)).toBe("nano");
    expect(scoreToTier(20)).toBe("nano");
    expect(scoreToTier(21)).toBe("small");
    expect(scoreToTier(40)).toBe("small");
    expect(scoreToTier(41)).toBe("medium");
    expect(scoreToTier(60)).toBe("medium");
    expect(scoreToTier(61)).toBe("large");
    expect(scoreToTier(80)).toBe("large");
    expect(scoreToTier(81)).toBe("xlarge");
    expect(scoreToTier(100)).toBe("xlarge");
  });

  it("exposes design default band ranges", () => {
    expect(DEFAULT_SCORE_BANDS).toEqual({
      nano: [0, 20],
      small: [21, 40],
      medium: [41, 60],
      large: [61, 80],
      xlarge: [81, 100],
    });
  });
});

describe("role base scores", () => {
  it("uses design defaults", () => {
    expect(roleBase("plan_writer")).toBe(70);
    expect(roleBase("plan_reviewer")).toBe(70);
    expect(roleBase("lead")).toBe(50);
    expect(roleBase("reviewer")).toBe(45);
    expect(roleBase("worker")).toBe(30);
    expect(roleBase("qa")).toBe(25);
    expect(roleBase("unknown_role")).toBe(30);
  });
});

describe("locBucket", () => {
  const w = DEFAULT_COMPLEXITY_WEIGHTS;
  it("picks exactly one bucket", () => {
    expect(locBucket(undefined, w)).toBe(w.loc_0);
    expect(locBucket(0, w)).toBe(w.loc_0);
    expect(locBucket(1, w)).toBe(w.loc_1_50);
    expect(locBucket(50, w)).toBe(w.loc_1_50);
    expect(locBucket(51, w)).toBe(w.loc_51_200);
    expect(locBucket(200, w)).toBe(w.loc_51_200);
    expect(locBucket(201, w)).toBe(w.loc_201_800);
    expect(locBucket(800, w)).toBe(w.loc_201_800);
    expect(locBucket(801, w)).toBe(w.loc_801_plus);
  });
});

describe("estimateComplexity (KD-41)", () => {
  it("returns raw worker base with no additives as small-band score", () => {
    const { score, tier } = estimateComplexity(baseSignals({ role: "worker" }));
    expect(score).toBe(30);
    expect(tier).toBe("small");
  });

  it("plan_writer base lands in large band before floors", () => {
    const { score, tier } = estimateComplexity(
      baseSignals({ role: "plan_writer" }),
    );
    expect(score).toBe(70);
    expect(tier).toBe("large");
  });

  it("caps scope path points", () => {
    const uncapped = estimateComplexity(
      baseSignals({ scope_path_count: 100 }),
    );
    // 30 + min(24, 100*3) = 54
    expect(uncapped.score).toBe(54);
  });

  it("applies security risk once", () => {
    const both = estimateComplexity(
      baseSignals({
        risk_labels: ["security", "public_api"],
        task_type_labels: ["security"],
      }),
    );
    // 30 + 20 once
    expect(both.score).toBe(50);
  });

  it("adds prior_failure_points per failure", () => {
    const { score } = estimateComplexity(
      baseSignals({ prior_failures: 2 }),
    );
    // 30 + 2*15 = 60
    expect(score).toBe(60);
  });

  it("adds critical path points", () => {
    const { score } = estimateComplexity(
      baseSignals({ is_critical_path: true }),
    );
    expect(score).toBe(40);
  });

  it("plan soft prior pulls toward midpoint by at most ±8", () => {
    // worker base 30; plan xlarge mid 90 → +8 only
    const up = estimateComplexity(
      baseSignals({ plan_estimate_tier: "xlarge" }),
    );
    expect(up.score).toBe(38);

    // plan_writer 70; plan nano mid 10 → -8
    const down = estimateComplexity(
      baseSignals({ role: "plan_writer", plan_estimate_tier: "nano" }),
    );
    expect(down.score).toBe(62);
  });

  it("clamps score to 0..100", () => {
    expect(clampScore(-5)).toBe(0);
    expect(clampScore(105.4)).toBe(100);
    expect(clampScore(40.4)).toBe(40);
    expect(clampScore(40.5)).toBe(41);

    const high = estimateComplexity(
      baseSignals({
        role: "plan_writer",
        scope_path_count: 20,
        scope_loc_est: 900,
        depends_on_count: 10,
        acceptance_command_count: 10,
        title_desc_chars: 10_000,
        is_critical_path: true,
        prior_failures: 5,
        risk_labels: ["security"],
      }),
    );
    expect(high.score).toBeLessThanOrEqual(100);
    expect(high.score).toBeGreaterThanOrEqual(0);
  });

  it("securityRiskHit matches design labels", () => {
    expect(
      securityRiskHit(
        baseSignals({ risk_labels: ["data_migration"] }),
      ),
    ).toBe(true);
    expect(
      securityRiskHit(baseSignals({ task_type_labels: ["security"] })),
    ).toBe(true);
    expect(securityRiskHit(baseSignals({ risk_labels: ["perf"] }))).toBe(
      false,
    );
  });

  it("planTierSoftPrior is bounded", () => {
    expect(planTierSoftPrior("xlarge", 10)).toBe(8);
    expect(planTierSoftPrior("nano", 90)).toBe(-8);
    expect(planTierSoftPrior(undefined, 50)).toBe(0);
    expect(TIER_BAND_MIDPOINT.medium).toBe(50);
  });
});
