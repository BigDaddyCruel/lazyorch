import { describe, expect, it } from "vitest";
import {
  ConfigValidationError,
  createDefaultConfig,
  defaultConfig,
  parseConfig,
  parseConfigYaml,
  stringifyConfigYaml,
} from "./index.js";

describe("parseConfig / defaults", () => {
  it("fills design defaults from empty object", () => {
    const { config, packing, warnings } = parseConfig({});
    expect(config.scheduling.max_concurrent_agents).toBe(8);
    expect(config.elasticity.max_workers).toBe(4);
    expect(config.reserve_slots.lead).toBe(1);
    expect(config.team.min_reviewers).toBe(1);
    expect(config.team.min_qa).toBe(1);
    expect(config.gates.plan_approve).toBe(true);
    expect(config.gates.merge).toBe(true);
    expect(config.gates.timeout_action).toBe("none");
    expect(config.gates.plan_reject_action).toBe("cancel");
    expect(packing.ok).toBe(true);
    // Design defaults: min 7 ≤ 8 ok; peak 1+4+2+2=9 > 8 → soft warn
    expect(warnings.some((w) => w.includes("peak"))).toBe(true);
  });

  it("createDefaultConfig produces valid packable config", () => {
    const config = createDefaultConfig("demo-app");
    expect(config.project.name).toBe("demo-app");
    expect(config.scheduling.max_concurrent_agents).toBe(8);
    expect(config.elasticity.max_workers).toBe(4);
  });

  it("rejects invalid adapter registry entry", () => {
    expect(() =>
      parseConfig({
        adapters: {
          registry: [{ id: "" }],
        },
      }),
    ).toThrow(ConfigValidationError);
  });

  it("accepts adapters registry shape", () => {
    const { config } = parseConfig({
      adapters: {
        default: "aider",
        registry: [
          {
            id: "aider",
            display_name: "Aider",
            binary: "aider",
            enabled: true,
            source: "user_config",
          },
        ],
      },
    });
    expect(config.adapters.default).toBe("aider");
    expect(config.adapters.registry).toHaveLength(1);
    expect(config.adapters.registry[0]?.id).toBe("aider");
  });

  it("fails hard on min-team slot packing invariant", () => {
    expect(() =>
      parseConfig({
        elasticity: { max_workers: 6 },
        scheduling: { max_concurrent_agents: 6 },
        reserve_slots: { lead: 1 },
        team: { min_reviewers: 1, min_qa: 1 },
      }),
    ).toThrow(/slot packing/);
  });

  it("allows packing errors when enforcePacking is false", () => {
    const { packing } = parseConfig(
      {
        elasticity: { max_workers: 6 },
        scheduling: { max_concurrent_agents: 6 },
        team: { min_reviewers: 1, min_qa: 1 },
      },
      { enforcePacking: false },
    );
    expect(packing.ok).toBe(false);
    expect(packing.minRequired).toBe(9); // 1+6+1+1
  });

  it("emits peak packing warning without failing", () => {
    const { packing, warnings } = parseConfig({
      elasticity: { max_workers: 4 },
      scheduling: { max_concurrent_agents: 7 },
      team: {
        min_reviewers: 1,
        max_reviewers: 2,
        min_qa: 1,
        max_qa: 2,
      },
    });
    expect(packing.ok).toBe(true);
    expect(warnings.some((w) => w.includes("peak"))).toBe(true);
  });

  it("applies models.routing_enabled ↔ features.model_routing alias", () => {
    const offViaFeatures = parseConfig({
      features: { model_routing: false },
    }).config;
    expect(offViaFeatures.models.routing_enabled).toBe(false);
    expect(offViaFeatures.features.model_routing).toBe(false);

    const offViaModels = parseConfig({
      models: { routing_enabled: false },
      features: { model_routing: true },
    }).config;
    expect(offViaModels.models.routing_enabled).toBe(false);
    expect(offViaModels.features.model_routing).toBe(false);
  });

  it("CI mode defaults timeout_action to fail when unset", () => {
    const interactive = parseConfig({}).config;
    expect(interactive.gates.timeout_action).toBe("none");

    const ci = parseConfig({}, { ci: true }).config;
    expect(ci.gates.timeout_action).toBe("fail");

    const explicit = parseConfig(
      { gates: { timeout_action: "none" } },
      { ci: true },
    ).config;
    expect(explicit.gates.timeout_action).toBe("none");
  });

  it("rejects min_reviewers > max_reviewers", () => {
    expect(() =>
      parseConfig({
        team: { min_reviewers: 3, max_reviewers: 1 },
      }),
    ).toThrow(ConfigValidationError);
  });

  it("parses YAML and round-trips defaults", () => {
    const yaml = `
project:
  name: sample
elasticity:
  max_workers: 4
scheduling:
  max_concurrent_agents: 8
reserve_slots:
  lead: 1
team:
  min_reviewers: 1
  min_qa: 1
gates:
  plan_approve: true
  merge: true
`;
    const { config } = parseConfigYaml(yaml);
    expect(config.project.name).toBe("sample");
    expect(config.elasticity.max_workers).toBe(4);

    const dumped = stringifyConfigYaml(config);
    const again = parseConfigYaml(dumped);
    expect(again.config.project.name).toBe("sample");
    expect(again.config.scheduling.max_concurrent_agents).toBe(8);
  });

  it("rejects invalid YAML", () => {
    expect(() => parseConfigYaml("{{not valid yaml")).toThrow(ConfigValidationError);
  });

  it("defaultConfig honors partial overrides", () => {
    const config = defaultConfig({
      elasticity: { max_workers: 2 },
      gates: { plan_approve: false },
    });
    expect(config.elasticity.max_workers).toBe(2);
    expect(config.gates.plan_approve).toBe(false);
    expect(config.scheduling.max_concurrent_agents).toBe(8);
  });

  it("rejects non-object section values (no silent coercion)", () => {
    expect(() => parseConfig({ models: "nope" })).toThrow(ConfigValidationError);
    expect(() => parseConfig({ features: false })).toThrow(ConfigValidationError);
    expect(() =>
      parseConfig({ gates: "x" }, { ci: true }),
    ).toThrow(ConfigValidationError);
  });

  it("applies solo mode compensating gates and zero min team", () => {
    const { config, packing } = parseConfig({
      team: { mode: "solo" },
    });
    expect(config.team.mode).toBe("solo");
    expect(config.team.min_reviewers).toBe(0);
    expect(config.team.max_reviewers).toBe(0);
    expect(config.team.min_qa).toBe(0);
    expect(config.team.max_qa).toBe(0);
    expect(config.elasticity.max_workers).toBe(0);
    expect(config.elasticity.min_workers).toBe(0);
    expect(config.gates.task_approve).toBe(true);
    expect(config.gates.plan_approve).toBe(true);
    expect(config.gates.merge).toBe(true);
    expect(packing.ok).toBe(true);
    expect(packing.minRequired).toBe(1); // lead reserve only
  });

  it("rejects unknown top-level and section keys (strict)", () => {
    expect(() => parseConfig({ not_a_section: true })).toThrow(
      ConfigValidationError,
    );
    expect(() =>
      parseConfig({ elasticity: { max_worker: 4 } }),
    ).toThrow(ConfigValidationError);
    expect(() =>
      parseConfig({ scheduling: { max_concurrent_agent: 8 } }),
    ).toThrow(ConfigValidationError);
  });

  it("rejects duplicate adapters.registry ids", () => {
    expect(() =>
      parseConfig({
        adapters: {
          registry: [
            { id: "aider", binary: "aider" },
            { id: "aider", binary: "aider2" },
          ],
        },
      }),
    ).toThrow(/duplicate adapters\.registry id/);
  });
});
