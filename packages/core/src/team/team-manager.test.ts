import { describe, expect, it } from "vitest";
import {
  agentsByRole,
  buildTeam,
  mintWorkerAgent,
  preferredAdaptersForAgent,
} from "./team-manager.js";
import {
  DEFAULT_CODING_PREFERRED_ADAPTERS,
  DEFAULT_QA_PREFERRED_ADAPTERS,
  preferredAdaptersForRole,
} from "./role-templates.js";

describe("buildTeam", () => {
  it("full mode seeds lead + min reviewers + min qa with preferred_adapters", () => {
    let n = 0;
    const built = buildTeam({
      run_id: "run_test",
      mode: "full",
      min_reviewers: 1,
      max_reviewers: 2,
      min_qa: 1,
      max_qa: 2,
      now: "2026-01-01T00:00:00.000Z",
      nextAgentId: () => `agt_${++n}`,
    });

    expect(built.team.mode).toBe("full");
    expect(built.team.lead_agent_id).toBe("agt_1");
    expect(built.agents).toHaveLength(3); // lead + 1 rev + 1 qa
    expect(built.limits.max_workers).toBe(4);
    expect(built.limits.min_reviewers).toBe(1);

    const lead = built.agents.find((a) => a.role === "lead")!;
    expect(lead.preferred_adapters).toEqual([...DEFAULT_CODING_PREFERRED_ADAPTERS]);
    expect(lead.labels).toContain("architect-lead");

    const rev = agentsByRole(built.agents, "reviewer")[0]!;
    expect(rev.preferred_adapters[0]).toBe("claude");
    expect(rev.labels).toContain("code-reviewer");

    const qa = agentsByRole(built.agents, "qa")[0]!;
    expect(qa.preferred_adapters).toEqual([...DEFAULT_QA_PREFERRED_ADAPTERS]);
  });

  it("solo mode creates lead only and zero caps + forced gates", () => {
    let n = 0;
    const built = buildTeam({
      run_id: "run_solo",
      mode: "solo",
      min_reviewers: 2,
      min_qa: 2,
      max_workers: 4,
      now: "2026-01-01T00:00:00.000Z",
      nextAgentId: () => `agt_${++n}`,
    });

    expect(built.team.mode).toBe("solo");
    expect(built.agents).toHaveLength(1);
    expect(built.agents[0]!.role).toBe("lead");
    expect(built.limits.max_workers).toBe(0);
    expect(built.limits.max_reviewers).toBe(0);
    expect(built.limits.max_qa).toBe(0);
    expect(built.limits.gates.task_approve).toBe(true);
    expect(built.limits.gates.plan_approve).toBe(true);
    expect(built.limits.gates.merge).toBe(true);
    expect(built.limits.allow_plan_writer_eq_reviewer).toBe(true);
  });

  it("honors preferred_adapters_by_role overrides", () => {
    let n = 0;
    const built = buildTeam({
      run_id: "run_ovr",
      mode: "full",
      min_reviewers: 0,
      min_qa: 0,
      preferred_adapters_by_role: {
        lead: ["codex", "claude"],
      },
      nextAgentId: () => `agt_${++n}`,
    });
    expect(built.agents[0]!.preferred_adapters).toEqual(["codex", "claude"]);
  });

  it("threads full-mode gate flags into limits", () => {
    let n = 0;
    const built = buildTeam({
      run_id: "run_gates",
      mode: "full",
      min_reviewers: 0,
      min_qa: 0,
      gates: {
        task_approve: true,
        plan_approve: false,
        merge: false,
      },
      nextAgentId: () => `agt_${++n}`,
    });
    expect(built.limits.gates).toEqual({
      task_approve: true,
      plan_approve: false,
      merge: false,
    });
  });
});

describe("mintWorkerAgent", () => {
  it("mints worker from template with labels and preferred_adapters", () => {
    const agent = mintWorkerAgent({
      run_id: "run_1",
      template_id: "backend-dev",
      nextAgentId: () => "agt_w1",
      now: "2026-01-01T00:00:00.000Z",
    });
    expect(agent.role).toBe("worker");
    expect(agent.id).toBe("agt_w1");
    expect(agent.labels).toContain("backend");
    expect(agent.preferred_adapters).toEqual([...DEFAULT_CODING_PREFERRED_ADAPTERS]);
  });
});

describe("preferredAdaptersForRole / preferredAdaptersForAgent", () => {
  it("returns role defaults", () => {
    expect(preferredAdaptersForRole("worker")[0]).toBe("claude");
    expect(preferredAdaptersForRole("qa")[0]).toBe("shell");
  });

  it("prefers agent.preferred_adapters when set", () => {
    const agent = mintWorkerAgent({
      run_id: "r",
      template_id: "fullstack-dev",
      preferred_adapters: ["grok"],
      nextAgentId: () => "agt_x",
    });
    expect(preferredAdaptersForAgent(agent, "worker")).toEqual(["grok"]);
  });
});

describe("resolveRoleTemplate catalog isolation", () => {
  it("does not mutate shared catalog labels when override path is used", async () => {
    const { resolveRoleTemplate, getRoleTemplate } = await import(
      "./role-templates.js"
    );
    const resolved = resolveRoleTemplate("fullstack-dev", "worker", {
      worker: ["codex"],
    });
    resolved.labels.push("MUTATED");
    resolved.skills.push("MUTATED");
    const again = getRoleTemplate("fullstack-dev")!;
    expect(again.labels).not.toContain("MUTATED");
    expect(again.skills).not.toContain("MUTATED");
    expect(again.preferred_adapters[0]).toBe("claude");
  });
});
