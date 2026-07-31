import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../schema.js";
import type { Run } from "../types/run.js";
import type { Task } from "../types/task.js";
import {
  applyTerminalFailedPolicy,
  terminalFailedTasks,
} from "./terminal-failed.js";

const FIXED = "2026-04-01T00:00:00.000Z";

function run(phase: Run["phase"] = "Implementing"): Run {
  return {
    schema_version: SCHEMA_VERSION,
    id: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
    project_id: "proj",
    phase,
    idea: "x",
    created_at: FIXED,
    updated_at: FIXED,
  };
}

function task(
  partial: Partial<Task> & Pick<Task, "id" | "status">,
): Task {
  return {
    id: partial.id,
    run_id: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
    title: "T",
    description: "d",
    status: partial.status,
    origin: "plan",
    priority: 2,
    depends_on: [],
    role_affinity: ["worker"],
    scope: ["src/**"],
    acceptance: ["test"],
    review_criteria: [],
    workspace_mode: "worktree",
    attempt: 3,
    max_attempts: 3,
    artifacts: [],
    ...partial,
  };
}

describe("terminalFailedTasks", () => {
  it("selects failed with attempt >= max_attempts", () => {
    const list = terminalFailedTasks([
      task({ id: "tsk_a", status: "failed", attempt: 3, max_attempts: 3 }),
      task({ id: "tsk_b", status: "failed", attempt: 1, max_attempts: 3 }),
      task({ id: "tsk_c", status: "ready", attempt: 3, max_attempts: 3 }),
    ]);
    expect(list.map((t) => t.id)).toEqual(["tsk_a"]);
  });
});

describe("applyTerminalFailedPolicy (KD-36)", () => {
  it("gate (default) opens human_intervention", () => {
    const r = applyTerminalFailedPolicy(
      run(),
      [task({ id: "tsk_a", status: "failed", attempt: 3, max_attempts: 3 })],
      { now: () => FIXED, nextGateId: () => "gate_test_1" },
    );
    expect(r.run.phase).toBe("Implementing");
    expect(r.gates).toHaveLength(1);
    expect(r.gates[0]?.type).toBe("human_intervention");
    expect(r.gates[0]?.payload).toMatchObject({
      task_ids: ["tsk_a"],
      reason: "task_attempts_exhausted",
    });
    expect(r.escalated_task_ids).toEqual(["tsk_a"]);
  });

  it("fail_run transitions run to Failed", () => {
    const r = applyTerminalFailedPolicy(
      run(),
      [task({ id: "tsk_a", status: "failed", attempt: 3, max_attempts: 3 })],
      { on_task_terminal_failed: "fail_run", now: () => FIXED },
    );
    expect(r.run.phase).toBe("Failed");
    expect(r.gates).toHaveLength(0);
  });

  it("wait does nothing", () => {
    const r = applyTerminalFailedPolicy(
      run(),
      [task({ id: "tsk_a", status: "failed", attempt: 3, max_attempts: 3 })],
      { on_task_terminal_failed: "wait" },
    );
    expect(r.run.phase).toBe("Implementing");
    expect(r.gates).toHaveLength(0);
    expect(r.escalated_task_ids).toHaveLength(0);
  });

  it("respects failed_escalation_ms grace", () => {
    const r = applyTerminalFailedPolicy(
      run(),
      [task({ id: "tsk_a", status: "failed", attempt: 3, max_attempts: 3 })],
      {
        failed_escalation_ms: 60_000,
        failed_at_ms: new Map([["tsk_a", 1_000]]),
        now_ms: 1_000 + 10_000,
      },
    );
    expect(r.gates).toHaveLength(0);
  });
});
