import { describe, expect, it } from "vitest";
import type { Task } from "../types/task.js";
import {
  canStartQaSession,
  canStartReviewerSession,
  defaultEphemeralPolicy,
  DEFAULT_REVIEWER_IDLE_EXIT_MS,
  reviewQueueTasks,
  shouldIdleExitEphemeral,
  withinRestartBudget,
} from "./ephemeral.js";

function task(id: string, status: Task["status"], extra: Partial<Task> = {}): Task {
  return {
    id,
    run_id: "run_1",
    title: id,
    description: "",
    status,
    origin: "plan",
    priority: 2,
    depends_on: [],
    role_affinity: ["worker"],
    scope: [],
    acceptance: [],
    review_criteria: [],
    workspace_mode: "worktree",
    attempt: 1,
    max_attempts: 3,
    artifacts: [],
    ...extra,
  };
}

describe("ephemeral session policy", () => {
  it("defaults reviewer idle_exit_ms to 60s", () => {
    const p = defaultEphemeralPolicy("reviewer");
    expect(p.mode).toBe("ephemeral");
    expect(p.idle_exit_ms).toBe(DEFAULT_REVIEWER_IDLE_EXIT_MS);
    expect(p.max_restarts_per_hour).toBe(6);
  });

  it("shouldIdleExitEphemeral requires empty queue and idle duration", () => {
    expect(
      shouldIdleExitEphemeral({
        role: "reviewer",
        last_activity_ms: 0,
        now_ms: 59_999,
        idle_exit_ms: 60_000,
        has_assigned_work: false,
        global_queue_empty: true,
      }),
    ).toBe(false);

    expect(
      shouldIdleExitEphemeral({
        role: "reviewer",
        last_activity_ms: 0,
        now_ms: 60_000,
        idle_exit_ms: 60_000,
        has_assigned_work: false,
        global_queue_empty: true,
      }),
    ).toBe(true);
  });

  it("never idle-exits while assigned work remains", () => {
    expect(
      shouldIdleExitEphemeral({
        role: "reviewer",
        last_activity_ms: 0,
        now_ms: 120_000,
        idle_exit_ms: 60_000,
        has_assigned_work: true,
        global_queue_empty: true,
      }),
    ).toBe(false);
  });

  it("never idle-exits when global queue still has work", () => {
    expect(
      shouldIdleExitEphemeral({
        role: "qa",
        last_activity_ms: 0,
        now_ms: 120_000,
        idle_exit_ms: 60_000,
        has_assigned_work: false,
        global_queue_empty: false,
      }),
    ).toBe(false);
  });

  it("canStartReviewerSession respects queue, caps, slots, mode", () => {
    expect(
      canStartReviewerSession({
        review_queue_count: 1,
        active_reviewers: 0,
        max_reviewers: 2,
        free_slots: 1,
        mode_allows: true,
      }),
    ).toBe(true);

    expect(
      canStartReviewerSession({
        review_queue_count: 1,
        active_reviewers: 0,
        max_reviewers: 2,
        free_slots: 1,
        mode_allows: false, // solo
      }),
    ).toBe(false);

    expect(
      canStartReviewerSession({
        review_queue_count: 0,
        active_reviewers: 0,
        max_reviewers: 2,
        free_slots: 1,
        mode_allows: true,
      }),
    ).toBe(false);

    expect(
      canStartReviewerSession({
        review_queue_count: 3,
        active_reviewers: 2,
        max_reviewers: 2,
        free_slots: 2,
        mode_allows: true,
      }),
    ).toBe(false);
  });

  it("canStartQaSession mirrors reviewer rules", () => {
    expect(
      canStartQaSession({
        qa_work_pending: true,
        active_qa: 0,
        max_qa: 1,
        free_slots: 1,
        mode_allows: true,
      }),
    ).toBe(true);
    expect(
      canStartQaSession({
        qa_work_pending: true,
        active_qa: 0,
        max_qa: 0,
        free_slots: 1,
        mode_allows: true,
      }),
    ).toBe(false);
  });

  it("reviewQueueTasks includes review and needs_re_review", () => {
    const tasks = [
      task("a", "review"),
      task("b", "in_progress", { needs_re_review: true }),
      task("c", "ready"),
      task("d", "in_progress"),
    ];
    const q = reviewQueueTasks(tasks);
    expect(q.map((t) => t.id).sort()).toEqual(["a", "b"]);
  });

  it("withinRestartBudget allows N restarts inclusive", () => {
    // max=6 → restarts 0..6 allowed; 7th crash exhausts
    expect(withinRestartBudget(5, 6)).toBe(true);
    expect(withinRestartBudget(6, 6)).toBe(true);
    expect(withinRestartBudget(7, 6)).toBe(false);
    expect(withinRestartBudget(0, 0)).toBe(true); // first start; post-crash uses count≥1
    expect(withinRestartBudget(1, 0)).toBe(false);
  });
});
