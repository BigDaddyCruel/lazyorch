import { describe, expect, it } from "vitest";
import { dryRunRoute } from "./dry-run.js";
import { modelRoutedEvent, toModelRoutedPayload } from "./events.js";
import { estimateComplexity, normalizeSignals } from "./estimator.js";
import { routeModel } from "./router.js";
import type { AdapterRouteInfo, ComplexitySignals } from "./types.js";
import { DEFAULT_TIER_MAPS } from "./defaults.js";

function signals(
  overrides: Partial<ComplexitySignals> = {},
): Partial<ComplexitySignals> {
  return overrides;
}

const fullClaude: AdapterRouteInfo = {
  id: "claude",
  healthy: true,
  tier_map: { ...DEFAULT_TIER_MAPS.claude },
};

describe("role floors (unpinned)", () => {
  it("raises worker estimate below floor up to small", () => {
    // qa base 25 → nano band; floor is small
    const result = routeModel({
      role: "qa",
      signals: signals({ role: "qa" }),
      adapters: [fullClaude],
    });
    expect(result.tier).toBe("small");
    expect(result.reason).toBe("estimate");
    expect(result.floor_violated).toBe(false);
    expect(result.pin_locked).toBe(false);
  });

  it("raises plan_writer to at least large via floor when estimate dips", () => {
    // With soft prior toward nano, score can drop to 62 still large;
    // force tiny role base via config to exercise floor raise.
    const result = routeModel({
      role: "plan_writer",
      signals: signals({ role: "plan_writer" }),
      config: {
        complexity_weights: {
          role_base: { plan_writer: 10 },
        },
      },
      adapters: [fullClaude],
    });
    // raw estimate ~10 → nano; floor large
    expect(result.tier).toBe("large");
    expect(result.pin_locked).toBe(false);
  });

  it("applies optional role ceiling when not pinned", () => {
    const result = routeModel({
      role: "worker",
      signals: signals({
        role: "worker",
        risk_labels: ["security"],
        is_critical_path: true,
        prior_failures: 2,
        scope_path_count: 8,
      }),
      config: {
        role_tier_ceiling: { worker: "medium" },
      },
      adapters: [fullClaude],
    });
    expect(result.tier).toBe("medium");
  });
});

describe("pin_locked (KD-42)", () => {
  it("pin below floor: plan_writer + tier_override nano → nano / override", () => {
    const result = routeModel({
      role: "plan_writer",
      signals: signals({ role: "plan_writer" }),
      task_pin: { tier_override: "nano" },
      adapters: [fullClaude],
    });
    expect(result.tier).toBe("nano");
    expect(result.reason).toBe("override");
    expect(result.floor_violated).toBe(false);
    expect(result.pin_locked).toBe(true);
    expect(result.model).toBe("claude-haiku-4-5");
  });

  it("pin above ceiling still wins", () => {
    const result = routeModel({
      role: "qa",
      signals: signals({ role: "qa" }),
      task_pin: { tier_override: "xlarge" },
      config: {
        role_tier_ceiling: { qa: "small" },
      },
      adapters: [fullClaude],
    });
    expect(result.tier).toBe("xlarge");
    expect(result.reason).toBe("override");
    expect(result.pin_locked).toBe(true);
  });

  it("pin beats budget cap (no floor_violated)", () => {
    const result = routeModel({
      role: "plan_writer",
      signals: signals({ role: "plan_writer" }),
      task_pin: { tier_override: "xlarge" },
      budget_pressure: true,
      config: { budget_tier_cap: "medium" },
      adapters: [fullClaude],
    });
    expect(result.tier).toBe("xlarge");
    expect(result.reason).toBe("override");
    expect(result.floor_violated).toBe(false);
    expect(result.pin_locked).toBe(true);
  });

  it("task pin beats run pin beats lead pin", () => {
    const result = routeModel({
      role: "worker",
      task_pin: { tier_override: "nano" },
      run_pin: { tier_override: "large" },
      lead_pin: { tier_override: "xlarge" },
      adapters: [fullClaude],
    });
    expect(result.tier).toBe("nano");
    expect(result.reason).toBe("override");
  });

  it("run pin beats lead when task has no tier/model pin", () => {
    const result = routeModel({
      role: "worker",
      run_pin: { tier_override: "large" },
      lead_pin: { tier_override: "xlarge" },
      adapters: [fullClaude],
    });
    expect(result.tier).toBe("large");
    expect(result.reason).toBe("override");
  });

  it("adapter_override alone does NOT set pin_locked (floors still apply)", () => {
    const result = routeModel({
      role: "qa",
      signals: signals({ role: "qa" }),
      task_pin: { adapter_override: "claude" },
      adapters: [fullClaude],
    });
    // qa base 25 → nano, floor small
    expect(result.tier).toBe("small");
    expect(result.pin_locked).toBe(false);
    expect(result.reason).toBe("estimate");
    expect(result.adapter_id).toBe("claude");
  });

  it("model_override locks model and sets pin_locked", () => {
    const result = routeModel({
      role: "worker",
      task_pin: { model_override: "claude-opus-4-6" },
      adapters: [fullClaude],
    });
    expect(result.pin_locked).toBe(true);
    expect(result.reason).toBe("override");
    expect(result.model).toBe("claude-opus-4-6");
    expect(result.tier).toBe("xlarge"); // inferred from tier_map
  });

  it("task tier pin beats lower-priority run model pin (single-source)", () => {
    // KD-42: task > run; do not field-merge run model over task tier
    const result = routeModel({
      role: "worker",
      task_pin: { tier_override: "nano" },
      run_pin: { model_override: "claude-opus-4-6" },
      adapters: [fullClaude],
    });
    expect(result.tier).toBe("nano");
    expect(result.model).toBe("claude-haiku-4-5");
    expect(result.reason).toBe("override");
    expect(result.pin_locked).toBe(true);
  });

  it("same-source model_override beats tier_override", () => {
    const result = routeModel({
      role: "worker",
      task_pin: {
        tier_override: "nano",
        model_override: "claude-opus-4-6",
      },
      adapters: [fullClaude],
    });
    expect(result.model).toBe("claude-opus-4-6");
    expect(result.tier).toBe("xlarge");
    expect(result.reason).toBe("override");
  });

  it("task model pin beats run tier pin", () => {
    const result = routeModel({
      role: "worker",
      task_pin: { model_override: "claude-opus-4-6" },
      run_pin: { tier_override: "nano" },
      adapters: [fullClaude],
    });
    expect(result.model).toBe("claude-opus-4-6");
    expect(result.tier).toBe("xlarge");
    expect(result.reason).toBe("override");
  });
});

describe("budget cap", () => {
  it("caps unpinned tier and may set floor_violated", () => {
    // plan_writer floor large; budget cap medium → below floor
    const result = routeModel({
      role: "plan_writer",
      signals: signals({ role: "plan_writer" }),
      budget_pressure: true,
      config: { budget_tier_cap: "medium" },
      adapters: [fullClaude],
    });
    expect(result.tier).toBe("medium");
    expect(result.reason).toBe("budget_cap");
    expect(result.floor_violated).toBe(true);
  });

  it("strict_role_floors hard-fails budget below floor", () => {
    const result = routeModel({
      role: "plan_writer",
      signals: signals({ role: "plan_writer" }),
      budget_pressure: true,
      config: {
        budget_tier_cap: "medium",
        strict_role_floors: true,
      },
      adapters: [fullClaude],
    });
    expect(result.error).toMatch(/strict_role_floors/);
    expect(result.floor_violated).toBe(true);
    expect(result.reason).toBe("budget_cap");
  });
});

describe("escalate on failure", () => {
  it("escalates with max(est, nextTier(last)) — no double bump", () => {
    // worker base 30 → small; last was small → next medium; max(small, medium)=medium
    const result = routeModel({
      role: "worker",
      signals: signals({ role: "worker" }),
      escalate: {
        consecutive_quality_fails: 1,
        last_model_tier: "small",
      },
      adapters: [fullClaude],
    });
    // estimate alone: small; escalate raises to medium via nextTier(last)
    expect(result.tier).toBe("medium");
    expect(result.reason).toBe("escalate");
    expect(result.score).toBe(30);
  });

  it("max(est, next) when estimate already higher than next(last)", () => {
    // large estimate via plan_writer; last nano → next small; max = large
    const result = routeModel({
      role: "plan_writer",
      signals: signals({ role: "plan_writer" }),
      escalate: {
        consecutive_quality_fails: 1,
        last_model_tier: "nano",
      },
      adapters: [fullClaude],
    });
    expect(result.tier).toBe("large");
    // estimate already large; escalate max doesn't raise further
    // reason: if tier == tier_est, design says reason escalate only if raised
    // our impl sets escalate only when tier > tierEst
    expect(["estimate", "escalate"]).toContain(result.reason);
  });

  it("escalate then full 4a–9: pin still wins (reason override)", () => {
    const result = routeModel({
      role: "worker",
      signals: signals({ role: "worker" }),
      escalate: {
        consecutive_quality_fails: 2,
        last_model_tier: "medium",
      },
      task_pin: { tier_override: "nano" },
      adapters: [fullClaude],
    });
    expect(result.tier).toBe("nano");
    expect(result.reason).toBe("override");
    expect(result.pin_locked).toBe(true);
  });

  it("does not escalate when escalate_on_failure is false", () => {
    const result = routeModel({
      role: "worker",
      signals: signals({ role: "worker" }),
      escalate: {
        consecutive_quality_fails: 5,
        last_model_tier: "small",
      },
      config: { escalate_on_failure: false },
      adapters: [fullClaude],
    });
    expect(result.reason).not.toBe("escalate");
  });

  it("respects escalate_after_failures threshold", () => {
    const result = routeModel({
      role: "worker",
      signals: signals({ role: "worker" }),
      escalate: {
        consecutive_quality_fails: 1,
        last_model_tier: "small",
      },
      config: { escalate_after_failures: 2 },
      adapters: [fullClaude],
    });
    expect(result.reason).not.toBe("escalate");
  });
});

describe("routing_enabled false", () => {
  it("uses role floor and reason routing_disabled (no score)", () => {
    const result = routeModel({
      role: "worker",
      signals: signals({
        role: "worker",
        risk_labels: ["security"],
        prior_failures: 3,
      }),
      config: { routing_enabled: false },
      adapters: [fullClaude],
    });
    expect(result.reason).toBe("routing_disabled");
    expect(result.score).toBeUndefined();
    expect(result.tier).toBe("small"); // worker floor
    expect(result.adapter_id).toBe("claude");
    expect(result.model).toBe("claude-haiku-4-5");
  });

  it("unknown role defaults to medium when routing disabled", () => {
    const result = routeModel({
      role: "custom",
      config: { routing_enabled: false },
      adapters: [fullClaude],
    });
    expect(result.tier).toBe("medium");
    expect(result.reason).toBe("routing_disabled");
  });

  it("ignores tier/model pins when routing disabled (design step 1)", () => {
    const result = routeModel({
      role: "worker",
      task_pin: {
        model_override: "claude-opus-4-6",
        tier_override: "nano",
      },
      config: { routing_enabled: false },
      adapters: [fullClaude],
    });
    expect(result.reason).toBe("routing_disabled");
    expect(result.pin_locked).toBe(false);
    // worker floor small — not nano pin, not opus model
    expect(result.tier).toBe("small");
    expect(result.model).toBe("claude-haiku-4-5");
    expect(result.model).not.toBe("claude-opus-4-6");
  });

  it("still prefers adapter_override when routing disabled", () => {
    const codex: AdapterRouteInfo = {
      id: "codex",
      healthy: true,
      tier_map: { ...DEFAULT_TIER_MAPS.codex },
    };
    const result = routeModel({
      role: "worker",
      task_pin: { adapter_override: "codex" },
      config: { routing_enabled: false },
      adapters: [fullClaude, codex],
    });
    expect(result.reason).toBe("routing_disabled");
    expect(result.adapter_id).toBe("codex");
    expect(result.tier).toBe("small");
    expect(result.pin_locked).toBe(false);
  });
});

describe("deterministic shell path", () => {
  it("skips estimator when session_kind is deterministic", () => {
    const result = routeModel({
      role: "qa",
      session_kind: "deterministic",
      signals: signals({ role: "qa", prior_failures: 9 }),
    });
    expect(result.session_kind).toBe("deterministic");
    expect(result.tier).toBeNull();
    expect(result.model).toBe("n/a");
    expect(result.adapter_id).toBe("shell");
    expect(result.reason).toBe("deterministic");
    expect(result.score).toBeUndefined();
  });

  it("adapter_override shell is deterministic (skip estimator)", () => {
    const result = routeModel({
      role: "worker",
      task_pin: { adapter_override: "shell" },
      signals: signals({ role: "worker", risk_labels: ["security"] }),
    });
    expect(result.session_kind).toBe("deterministic");
    expect(result.adapter_id).toBe("shell");
    expect(result.tier).toBeNull();
    expect(result.reason).toBe("deterministic");
  });

  it("never picks shell on LLM path even if only shell listed", () => {
    const shellOnly: AdapterRouteInfo[] = [
      {
        id: "shell",
        healthy: true,
        is_shell: true,
        tier_map: {},
      },
    ];
    const result = routeModel({
      role: "worker",
      adapters: shellOnly,
      preference_order: ["shell"],
      adapters_default: "shell",
    });
    expect(result.error).toBe("no adapter for tier");
    // Error placeholder must not advertise shell on an LLM session
    expect(result.adapter_id).not.toBe("shell");
    expect(result.session_kind).toBe("llm");
    expect(result.reason).not.toBe("deterministic");
  });
});

describe("pickAdapter / tier maps", () => {
  it("prefers task adapter_override when healthy and supports tier", () => {
    const codex: AdapterRouteInfo = {
      id: "codex",
      healthy: true,
      tier_map: { ...DEFAULT_TIER_MAPS.codex },
    };
    const result = routeModel({
      role: "worker",
      task_pin: { adapter_override: "codex", tier_override: "large" },
      adapters: [fullClaude, codex],
    });
    expect(result.adapter_id).toBe("codex");
    expect(result.model).toBe("gpt-5");
    expect(result.tier).toBe("large");
  });

  it("steps down on tier_map gap (unpinned) with reason tier_map_gap", () => {
    const limited: AdapterRouteInfo = {
      id: "limited",
      healthy: true,
      tier_map: { small: "tiny-model", nano: "tinier" },
    };
    const result = routeModel({
      role: "plan_writer",
      signals: signals({ role: "plan_writer" }),
      adapters: [limited],
      adapters_default: "limited",
      preference_order: ["limited"],
    });
    // floor large, no large in map → step down; may go below floor
    expect(result.tier).toBe("small");
    expect(result.reason).toBe("tier_map_gap");
    expect(result.floor_violated).toBe(true);
  });

  it("pin with missing adapter support errors (no silent step-down)", () => {
    const limited: AdapterRouteInfo = {
      id: "limited",
      healthy: true,
      tier_map: { small: "tiny-model" },
    };
    const result = routeModel({
      role: "worker",
      task_pin: { tier_override: "xlarge" },
      adapters: [limited],
      adapters_default: "limited",
      preference_order: ["limited"],
    });
    expect(result.error).toBe("no adapter for pin");
    expect(result.tier).toBe("xlarge");
  });
});

describe("model.routed event shape", () => {
  it("builds payload with required fields", () => {
    const result = routeModel({
      role: "worker",
      task_id: "tsk_1",
      adapters: [fullClaude],
    });
    const payload = toModelRoutedPayload(result, {
      role: "worker",
      task_id: "tsk_1",
    });
    expect(payload).toMatchObject({
      task_id: "tsk_1",
      role: "worker",
      tier: result.tier,
      adapter_id: result.adapter_id,
      model: result.model,
      reason: result.reason,
    });
    expect(payload.score).toBe(result.score);
    expect(payload.floor_violated).toBeUndefined();
  });

  it("includes floor_violated only when true", () => {
    const result = routeModel({
      role: "plan_writer",
      budget_pressure: true,
      config: { budget_tier_cap: "medium" },
      adapters: [fullClaude],
    });
    const payload = toModelRoutedPayload(result, { role: "plan_writer" });
    expect(payload.floor_violated).toBe(true);
    expect(payload.reason).toBe("budget_cap");
  });

  it("modelRoutedEvent wraps type + payload", () => {
    const result = routeModel({
      role: "worker",
      adapters: [fullClaude],
    });
    const ev = modelRoutedEvent(result, { role: "worker", task_id: "tsk_x" });
    expect(ev.type).toBe("model.routed");
    expect(ev.payload.task_id).toBe("tsk_x");
  });
});

describe("dry-run API helper", () => {
  it("returns dry_run flag and event payload", () => {
    const dry = dryRunRoute({
      role: "worker",
      task_id: "tsk_dry",
      extra: { adapters: [fullClaude] },
    });
    expect(dry.dry_run).toBe(true);
    expect(dry.event.role).toBe("worker");
    expect(dry.event.task_id).toBe("tsk_dry");
    expect(dry.tier).toBe(dry.event.tier);
  });
});

describe("effort mapping", () => {
  it("maps tier to effort", () => {
    expect(
      routeModel({
        role: "worker",
        task_pin: { tier_override: "nano" },
        adapters: [fullClaude],
      }).effort,
    ).toBe("low");
    expect(
      routeModel({
        role: "worker",
        task_pin: { tier_override: "medium" },
        adapters: [fullClaude],
      }).effort,
    ).toBe("medium");
    expect(
      routeModel({
        role: "worker",
        task_pin: { tier_override: "xlarge" },
        adapters: [fullClaude],
      }).effort,
    ).toBe("high");
  });
});

describe("estimator ↔ router consistency", () => {
  it("unpinned worker with no additives: score 30, tier small after floor", () => {
    const sig = normalizeSignals({ role: "worker" });
    const est = estimateComplexity(sig);
    expect(est.score).toBe(30);
    expect(est.tier).toBe("small");

    const routed = routeModel({
      role: "worker",
      signals: sig,
      adapters: [fullClaude],
    });
    expect(routed.score).toBe(30);
    expect(routed.tier).toBe("small");
    expect(routed.reason).toBe("estimate");
  });
});
