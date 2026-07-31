import { describe, expect, it } from "vitest";
import { defaultAdaptersForRouting } from "../models/defaults.js";
import { SCHEMA_VERSION } from "../schema.js";
import { mintPlanAgent } from "../team/team-manager.js";
import type { Agent } from "../types/agent.js";
import { SessionPlanReviewer, SessionPlanWriter } from "./handlers.js";
import { FakePlanningSession } from "./session-fakes.js";
import { planningSignals, routePlanningSession } from "./route.js";
import { validArtifacts, writeResult } from "./test-fixtures.js";

const FIXED = "2026-03-15T00:00:00.000Z";

function agent(role: "plan_writer" | "plan_reviewer"): Agent {
  return mintPlanAgent({
    run_id: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
    role,
    now: FIXED,
    nextAgentId: () =>
      role === "plan_writer"
        ? "agt_writerwriterwriterwriter"
        : "agt_reviewerreviewerreviewer",
  });
}

describe("planningSignals", () => {
  it("forces role and task_origin after overrides", () => {
    const s = planningSignals("plan_writer", {
      role: "worker",
      task_origin: "dynamic",
      scope_path_count: 3,
    });
    expect(s.role).toBe("plan_writer");
    expect(s.task_origin).toBe("plan");
    expect(s.scope_path_count).toBe(3);
  });
});

describe("routePlanningSession", () => {
  it("routes plan_writer and plan_reviewer to large tier via floor", () => {
    const writer = routePlanningSession({
      role: "plan_writer",
      agent: agent("plan_writer"),
      routing: {
        adapters: defaultAdaptersForRouting(),
      },
    });
    const reviewer = routePlanningSession({
      role: "plan_reviewer",
      agent: agent("plan_reviewer"),
      routing: {
        adapters: defaultAdaptersForRouting(),
      },
    });
    expect(writer.tier).toBe("large");
    expect(reviewer.tier).toBe("large");
    expect(writer.session_kind).toBe("llm");
    expect(writer.adapter_id).toBeTruthy();
    expect(writer.model).not.toBe("n/a");
    // role base 70 lands in large band; floor large also enforces
    expect(writer.score).toBeGreaterThanOrEqual(61);
  });

  it("respects preferred_adapters order", () => {
    const route = routePlanningSession({
      role: "plan_writer",
      preferred_adapters: ["codex", "claude"],
      routing: {
        adapters: defaultAdaptersForRouting(),
      },
    });
    expect(route.adapter_id).toBe("codex");
    expect(route.tier).toBe("large");
  });
});

describe("SessionPlanWriter / SessionPlanReviewer", () => {
  it("routes large tier and returns scripted artifacts via fake session", async () => {
    const artifacts = validArtifacts();
    const session = new FakePlanningSession({
      writes: [writeResult(artifacts)],
      reviews: [{ issues: [] }],
    });

    const writer = new SessionPlanWriter({
      session,
      agent: agent("plan_writer"),
      cwd: "/tmp/proj",
      routing: { adapters: defaultAdaptersForRouting() },
    });
    const reviewer = new SessionPlanReviewer({
      session,
      agent: agent("plan_reviewer"),
      cwd: "/tmp/proj",
      routing: { adapters: defaultAdaptersForRouting() },
    });

    const write = await writer.write({
      idea: "ship",
      run_id: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
      revision: 1,
      open_issues: [],
    });
    expect(write.artifacts).toEqual(artifacts);
    expect(writer.lastRoute?.tier).toBe("large");
    expect(session.byRole("plan_writer")[0]?.model_tier).toBe("large");
    expect(session.byRole("plan_writer")[0]?.skills).toContain("plan-writer");

    const review = await reviewer.review({
      idea: "ship",
      run_id: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
      revision: 1,
      artifacts,
      previous_issues: [],
    });
    expect(review.issues).toEqual([]);
    expect(reviewer.lastRoute?.tier).toBe("large");
    expect(session.byRole("plan_reviewer")[0]?.model_tier).toBe("large");
  });

  it("propagates session errors", async () => {
    const session = new FakePlanningSession({
      handler: async () => ({
        status: "error",
        error_message: "adapter down",
      }),
    });
    const writer = new SessionPlanWriter({
      session,
      agent: agent("plan_writer"),
      cwd: ".",
      routing: { adapters: defaultAdaptersForRouting() },
    });
    await expect(
      writer.write({
        idea: "x",
        run_id: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
        revision: 1,
        open_issues: [],
      }),
    ).rejects.toThrow(/adapter down/);
  });

  it("uses fixed_route when provided", async () => {
    const session = new FakePlanningSession({
      writes: [writeResult()],
    });
    const writer = new SessionPlanWriter({
      session,
      agent: agent("plan_writer"),
      cwd: ".",
      fixed_route: {
        session_kind: "llm",
        tier: "xlarge",
        adapter_id: "grok",
        model: "grok-4",
        reason: "override",
        floor_violated: false,
        pin_locked: true,
        score: 90,
      },
    });
    await writer.write({
      idea: "x",
      run_id: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
      revision: 1,
      open_issues: [],
    });
    expect(session.requests[0]?.adapter_id).toBe("grok");
    expect(session.requests[0]?.model).toBe("grok-4");
    expect(session.requests[0]?.model_tier).toBe("xlarge");
  });
});

describe("mintPlanAgent", () => {
  it("stamps default_tier large and coding preferred_adapters", () => {
    const a = mintPlanAgent({
      run_id: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
      role: "plan_writer",
      now: FIXED,
      nextAgentId: () => "agt_cccccccccccccccccccccccc",
    });
    expect(a.schema_version).toBe(SCHEMA_VERSION);
    expect(a.role).toBe("plan_writer");
    expect(a.default_tier).toBe("large");
    expect(a.preferred_adapters[0]).toBe("claude");
    expect(a.labels).toContain("plan-writer");
  });
});
