import { describe, expect, it } from "vitest";
import { exitImplementing } from "../orchestrator/run-fsm.js";
import { SCHEMA_VERSION } from "../schema.js";
import type { Run } from "../types/run.js";
import type { Task } from "../types/task.js";
import { FakeForgeGithub } from "./fakes.js";
import {
  applyMergeGateDecision,
  createMergeGate,
  hasPendingMergeGate,
  shouldAutoMerge,
} from "./merge-gate.js";
import { lifecycleTick } from "./phase.js";
import { runPrePrPhase, runPrOpenPhase } from "./prepr.js";

const FIXED = "2026-06-01T00:00:00.000Z";
const RUN_ID = "run_bbbbbbbbbbbbbbbbbbbbbbbb";

function baseRun(partial: Partial<Run> = {}): Run {
  return {
    schema_version: SCHEMA_VERSION,
    id: RUN_ID,
    project_id: "proj",
    phase: "Implementing",
    idea: "ship feature X",
    created_at: FIXED,
    updated_at: FIXED,
    feature_branch: `lazyorch/${RUN_ID}/feature`,
    feature_tip_sha: "tip_abc",
    qa: { passed_at_commit: "tip_abc" },
    ...partial,
  };
}

function doneTask(id: string): Task {
  return {
    id,
    run_id: RUN_ID,
    title: id,
    description: "",
    status: "done",
    origin: "plan",
    priority: 2,
    depends_on: [],
    role_affinity: [],
    scope: [],
    acceptance: [],
    review_criteria: [],
    workspace_mode: "worktree",
    attempt: 1,
    max_attempts: 3,
    artifacts: [],
  };
}

describe("Implementing exit → PrePR / CILoop short-circuit", () => {
  it("exits to PrePR when no ready PR", () => {
    const run = baseRun({ phase: "Implementing" });
    const next = exitImplementing(run, [doneTask("tsk_a")]);
    expect(next.phase).toBe("PrePR");
  });

  it("exits to CILoop when ready PR already exists", () => {
    const run = baseRun({
      phase: "Implementing",
      pr_ref: { number: 12, state: "ready", url: "u" },
    });
    const next = exitImplementing(run, [doneTask("tsk_a")]);
    expect(next.phase).toBe("CILoop");
  });

  it("stays PrePR path for draft PR", () => {
    const run = baseRun({
      phase: "Implementing",
      pr_ref: { number: 12, state: "draft" },
    });
    expect(exitImplementing(run, [doneTask("tsk_a")]).phase).toBe("PrePR");
  });
});

describe("PrePR / PROpen", () => {
  it("ensures ready PR and advances PrePR → PROpen → CILoop via lifecycleTick", async () => {
    const forge = new FakeForgeGithub();
    const run = baseRun({ phase: "PrePR" });
    const tick = await lifecycleTick({
      run,
      tasks: [doneTask("a")],
      forge,
      now: () => FIXED,
    });
    expect(tick.run.phase).toBe("CILoop");
    expect(tick.run.pr_ref?.state).toBe("ready");
    expect(forge.ensureCalls).toHaveLength(1);
    expect(tick.transitions.map((t) => `${t.from}->${t.to}`)).toEqual([
      "PrePR->PROpen",
      "PROpen->CILoop",
    ]);
  });

  it("skips forge when ready PR already linked", async () => {
    const forge = new FakeForgeGithub({
      pr: { number: 5, state: "ready", url: "u" },
    });
    const run = baseRun({
      phase: "PrePR",
      pr_ref: { number: 5, state: "ready", url: "u" },
    });
    const r = await runPrePrPhase(run, forge, {}, { now: () => FIXED });
    expect(r.run.phase).toBe("CILoop");
    expect(r.transitions[0]?.noop).toBe(true);
    expect(forge.ensureCalls).toHaveLength(0);
  });

  it("PROpen alone goes to CILoop", () => {
    const run = baseRun({
      phase: "PROpen",
      pr_ref: { number: 1, state: "ready" },
    });
    const r = runPrOpenPhase(run, { now: () => FIXED });
    expect(r.run.phase).toBe("CILoop");
  });

  it("PROpen rejects missing or non-ready pr_ref", () => {
    expect(() =>
      runPrOpenPhase(baseRun({ phase: "PROpen" }), { now: () => FIXED }),
    ).toThrow(/ready pr_ref/);
    expect(() =>
      runPrOpenPhase(
        baseRun({ phase: "PROpen", pr_ref: { number: 1, state: "draft" } }),
        { now: () => FIXED },
      ),
    ).toThrow(/ready pr_ref/);
  });
});

describe("CILoop", () => {
  it("pending stays CILoop", async () => {
    const forge = new FakeForgeGithub({
      pollDefault: {
        required_green: false,
        required_failed: false,
        pending: true,
        failed_checks: [],
        pending_checks: ["ci"],
      },
    });
    const run = baseRun({
      phase: "CILoop",
      pr_ref: { number: 1, state: "ready", head_sha: "tip_abc" },
    });
    const tick = await lifecycleTick({
      run,
      tasks: [doneTask("a")],
      forge,
      ciloop: { required_checks: ["ci"] },
    });
    expect(tick.run.phase).toBe("CILoop");
    expect(tick.poll_pending).toBe(true);
  });

  it("green → MergeReady", async () => {
    const forge = new FakeForgeGithub({
      pollDefault: {
        required_green: true,
        required_failed: false,
        pending: false,
        failed_checks: [],
        pending_checks: [],
        head_sha: "tip_abc",
      },
    });
    const run = baseRun({
      phase: "CILoop",
      pr_ref: { number: 1, state: "ready", head_sha: "tip_abc" },
    });
    const tick = await lifecycleTick({
      run,
      tasks: [doneTask("a")],
      forge,
    });
    expect(tick.run.phase).toBe("MergeReady");
  });

  it("failed → Implementing + dynamic CI fix tasks", async () => {
    const forge = new FakeForgeGithub({
      pollDefault: {
        required_green: false,
        required_failed: true,
        pending: false,
        failed_checks: ["test"],
        pending_checks: [],
      },
    });
    const run = baseRun({
      phase: "CILoop",
      pr_ref: { number: 1, state: "ready", head_sha: "tip_abc" },
      qa: { passed_at_commit: "tip_abc" },
    });
    let n = 0;
    const tick = await lifecycleTick({
      run,
      tasks: [doneTask("a")],
      forge,
      nextTaskId: () => {
        n += 1;
        return `tsk_${String(n).padStart(24, "c")}`;
      },
    });
    expect(tick.run.phase).toBe("Implementing");
    expect(tick.fix_task_ids).toHaveLength(1);
    expect(tick.tasks.some((t) => t.origin === "dynamic")).toBe(true);
    expect(tick.run.qa).toBeUndefined(); // invalidateRunQa deletes qa
  });
});

describe("merge gate", () => {
  it("opens pending merge gate on MergeReady (human)", async () => {
    const forge = new FakeForgeGithub({
      pr: { number: 3, state: "ready", url: "u" },
    });
    const run = baseRun({
      phase: "MergeReady",
      pr_ref: { number: 3, state: "ready", url: "u" },
    });
    const tick = await lifecycleTick({
      run,
      tasks: [doneTask("a")],
      forge,
      merge_gate: "human",
      gates_merge: true,
      nextGateId: () => "gate_dddddddddddddddddddddddd",
      now: () => FIXED,
    });
    expect(tick.gates).toHaveLength(1);
    expect(tick.gates[0]?.type).toBe("merge");
    expect(tick.gates[0]?.status).toBe("pending");
    expect(tick.merged).toBe(false);
    expect(tick.run.phase).toBe("MergeReady");
  });

  it("auto merge merges without gate", async () => {
    const forge = new FakeForgeGithub({
      pr: { number: 3, state: "ready", url: "u" },
    });
    const run = baseRun({
      phase: "MergeReady",
      pr_ref: { number: 3, state: "ready", url: "u" },
    });
    const tick = await lifecycleTick({
      run,
      tasks: [doneTask("a")],
      forge,
      merge_gate: "auto",
      now: () => FIXED,
    });
    expect(tick.merged).toBe(true);
    expect(tick.run.phase).toBe("Merged");
    expect(tick.run.pr_ref?.state).toBe("merged");
    expect(forge.mergeCalls).toHaveLength(1);
  });

  it("merge_approved path merges after human approve", async () => {
    const forge = new FakeForgeGithub({
      pr: { number: 3, state: "ready", url: "u" },
    });
    const run = baseRun({
      phase: "MergeReady",
      pr_ref: { number: 3, state: "ready", url: "u" },
    });
    const gate = createMergeGate({
      run_id: RUN_ID,
      pr_number: 3,
      now: () => FIXED,
      nextId: () => "gate_eeeeeeeeeeeeeeeeeeeeeeee",
    });
    const decided = applyMergeGateDecision(run, gate, "approve", {
      resolved_by: "human",
      now: () => FIXED,
    });
    expect(decided.should_merge).toBe(true);
    const tick = await lifecycleTick({
      run: decided.run,
      tasks: [doneTask("a")],
      forge,
      merge_approved: true,
      existing_gates: [decided.gate],
      now: () => FIXED,
    });
    expect(tick.merged).toBe(true);
    expect(tick.run.phase).toBe("Merged");
  });

  it("hasPendingMergeGate / shouldAutoMerge helpers", () => {
    const g = createMergeGate({
      run_id: RUN_ID,
      pr_number: 1,
      nextId: () => "gate_ffffffffffffffffffffffff",
      now: () => FIXED,
    });
    expect(hasPendingMergeGate([g], RUN_ID, 1)).toBe(true);
    expect(hasPendingMergeGate([g], RUN_ID, 2)).toBe(false);
    expect(shouldAutoMerge({ merge_gate: "auto", gates_merge: true })).toBe(
      true,
    );
    expect(shouldAutoMerge({ merge_gate: "human", gates_merge: false })).toBe(
      true,
    );
    expect(shouldAutoMerge({ merge_gate: "human", gates_merge: true })).toBe(
      false,
    );
  });

  it("reject keeps MergeReady", () => {
    const run = baseRun({
      phase: "MergeReady",
      pr_ref: { number: 1, state: "ready" },
    });
    const gate = createMergeGate({
      run_id: RUN_ID,
      pr_number: 1,
      nextId: () => "gate_111111111111111111111111",
      now: () => FIXED,
    });
    const r = applyMergeGateDecision(run, gate, "reject", {
      comment: "hold",
      now: () => FIXED,
    });
    expect(r.should_merge).toBe(false);
    expect(r.gate.status).toBe("rejected");
    expect(r.run.phase).toBe("MergeReady");
  });

  it("auto merge resolves pending merge gate", async () => {
    const forge = new FakeForgeGithub({
      pr: { number: 3, state: "ready", url: "u" },
    });
    const gate = createMergeGate({
      run_id: RUN_ID,
      pr_number: 3,
      nextId: () => "gate_222222222222222222222222",
      now: () => FIXED,
    });
    const tick = await lifecycleTick({
      run: baseRun({
        phase: "MergeReady",
        pr_ref: { number: 3, state: "ready", url: "u" },
      }),
      tasks: [doneTask("a")],
      forge,
      merge_gate: "auto",
      existing_gates: [gate],
      now: () => FIXED,
    });
    expect(tick.merged).toBe(true);
    expect(tick.gates.some((g) => g.id === gate.id && g.status === "approved")).toBe(
      true,
    );
  });

  it("changes_requested re-enters Implementing with dynamic tasks", async () => {
    const forge = new FakeForgeGithub({
      pr: { number: 3, state: "ready" },
    });
    const tick = await lifecycleTick({
      run: baseRun({
        phase: "MergeReady",
        pr_ref: { number: 3, state: "ready" },
        qa: { passed_at_commit: "tip_abc" },
      }),
      tasks: [doneTask("a")],
      forge,
      changes_requested: { summary: "please fix nits" },
      nextTaskId: () => "tsk_crcrcrcrcrcrcrcrcrcrcrcr",
      now: () => FIXED,
    });
    expect(tick.run.phase).toBe("Implementing");
    expect(tick.fix_task_ids).toHaveLength(1);
    expect(tick.tasks.some((t) => t.origin === "dynamic")).toBe(true);
    expect(tick.run.qa).toBeUndefined();
  });
});

describe("end-to-end MVP path (fakes)", () => {
  it("Implementing exit → PrePR → CILoop green → auto merge", async () => {
    const tasks = [doneTask("tsk_a")];
    const run = exitImplementing(baseRun({ phase: "Implementing" }), tasks);
    expect(run.phase).toBe("PrePR");

    const forge = new FakeForgeGithub({
      pollDefault: {
        required_green: true,
        required_failed: false,
        pending: false,
        failed_checks: [],
        pending_checks: [],
        head_sha: "tip_abc",
      },
    });

    let tick = await lifecycleTick({
      run,
      tasks,
      forge,
      now: () => FIXED,
    });
    expect(tick.run.phase).toBe("CILoop");

    tick = await lifecycleTick({
      run: tick.run,
      tasks: tick.tasks,
      forge,
      now: () => FIXED,
    });
    expect(tick.run.phase).toBe("MergeReady");

    tick = await lifecycleTick({
      run: tick.run,
      tasks: tick.tasks,
      forge,
      merge_gate: "auto",
      now: () => FIXED,
    });
    expect(tick.run.phase).toBe("Merged");
    expect(tick.merged).toBe(true);
  });

  it("re-exit with ready PR skips PrePR", () => {
    // After CI fix re-entry: still Implementing with ready pr_ref
    const run = baseRun({
      phase: "Implementing",
      pr_ref: { number: 9, state: "ready" },
    });
    const exited = exitImplementing(run, [doneTask("a")]);
    expect(exited.phase).toBe("CILoop");
  });
});
