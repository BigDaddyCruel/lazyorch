import { describe, expect, it } from "vitest";
import type { Task } from "../types/task.js";
import {
  afterConflictRework,
  applyIntegrateResult,
  applyReviewDecision,
  applyWorkerOutcome,
  ImplementingError,
  recoverIntegrateConflict,
} from "./outcomes.js";

function t(
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
    review_criteria: ["typecheck"],
    workspace_mode: "worktree",
    attempt: 1,
    max_attempts: 3,
    artifacts: [],
    ...partial,
  };
}

describe("applyWorkerOutcome", () => {
  it("submit_for_review → review", () => {
    const next = applyWorkerOutcome(t({ id: "tsk_a", status: "in_progress" }), {
      kind: "submit_for_review",
    });
    expect(next.status).toBe("review");
  });

  it("submit with material_product_change false → integrating", () => {
    const next = applyWorkerOutcome(t({ id: "tsk_a", status: "in_progress" }), {
      kind: "submit_for_review",
      material_product_change: false,
    });
    expect(next.status).toBe("integrating");
  });

  it("timeout requeues with attempt++ under max", () => {
    const next = applyWorkerOutcome(
      t({ id: "tsk_a", status: "in_progress", attempt: 1 }),
      { kind: "timeout" },
    );
    expect(next.status).toBe("ready");
    expect(next.attempt).toBe(2);
  });

  it("quality fail requeues via failed→ready with attempt++", () => {
    const next = applyWorkerOutcome(
      t({ id: "tsk_a", status: "in_progress", attempt: 1, max_attempts: 3 }),
      { kind: "fail" },
    );
    expect(next.status).toBe("ready");
    expect(next.attempt).toBe(2);
  });

  it("exhausted attempts → failed", () => {
    const next = applyWorkerOutcome(
      t({ id: "tsk_a", status: "in_progress", attempt: 3, max_attempts: 3 }),
      { kind: "fail" },
    );
    expect(next.status).toBe("failed");
  });

  it("rejects non-in_progress", () => {
    expect(() =>
      applyWorkerOutcome(t({ id: "tsk_a", status: "ready" }), {
        kind: "submit_for_review",
      }),
    ).toThrow(ImplementingError);
  });
});

describe("applyReviewDecision", () => {
  it("approve → integrating", () => {
    const next = applyReviewDecision(t({ id: "tsk_a", status: "review" }), {
      decision: "approve",
    });
    expect(next.status).toBe("integrating");
  });

  it("reject → ready with attempt++", () => {
    const next = applyReviewDecision(
      t({ id: "tsk_a", status: "review", attempt: 1 }),
      { decision: "reject" },
    );
    expect(next.status).toBe("ready");
    expect(next.attempt).toBe(2);
  });

  it("invalid leaves task in review", () => {
    const next = applyReviewDecision(t({ id: "tsk_a", status: "review" }), {
      decision: "invalid",
    });
    expect(next.status).toBe("review");
  });
});

describe("applyIntegrateResult (KD-33/34)", () => {
  it("ok → done and release locks", () => {
    const r = applyIntegrateResult(
      t({ id: "tsk_a", status: "integrating" }),
      { status: "ok", feature_tip_sha: "abc" },
    );
    expect(r.task.status).toBe("done");
    expect(r.feature_tip_sha).toBe("abc");
    expect(r.release_scope_locks).toBe(true);
    expect(r.release_mutex).toBe(true);
  });

  it("conflict → blocked/integrate_conflict; keep locks", () => {
    const r = applyIntegrateResult(
      t({ id: "tsk_a", status: "integrating" }),
      { status: "conflict", conflict: true, error_message: "CONFLICT" },
    );
    expect(r.task.status).toBe("blocked");
    expect(r.task.blocked_reason).toBe("integrate_conflict");
    expect(r.task.integrate_error).toBe("CONFLICT");
    expect(r.release_scope_locks).toBe(false);
    expect(r.release_mutex).toBe(true);
  });

  it("error → failed and release locks", () => {
    const r = applyIntegrateResult(
      t({ id: "tsk_a", status: "integrating" }),
      { status: "error", error_message: "boom" },
    );
    expect(r.task.status).toBe("failed");
    expect(r.release_scope_locks).toBe(true);
  });
});

describe("recoverIntegrateConflict", () => {
  it("blocked/integrate_conflict → ready with attempt++", () => {
    const next = recoverIntegrateConflict(
      t({
        id: "tsk_a",
        status: "blocked",
        blocked_reason: "integrate_conflict",
        integrate_error: "CONFLICT",
        attempt: 1,
      }),
    );
    expect(next.status).toBe("ready");
    expect(next.attempt).toBe(2);
    expect(next.blocked_reason).toBeUndefined();
  });

  it("rejects other blocked reasons", () => {
    expect(() =>
      recoverIntegrateConflict(
        t({
          id: "tsk_a",
          status: "blocked",
          blocked_reason: "scope_lock",
        }),
      ),
    ).toThrow(ImplementingError);
  });
});

describe("afterConflictRework", () => {
  it("material change → review + needs_re_review", () => {
    const next = afterConflictRework(
      t({ id: "tsk_a", status: "in_progress" }),
      true,
    );
    expect(next.status).toBe("review");
    expect(next.needs_re_review).toBe(true);
  });

  it("markers only → integrating", () => {
    const next = afterConflictRework(
      t({ id: "tsk_a", status: "in_progress" }),
      false,
    );
    expect(next.status).toBe("integrating");
  });
});
