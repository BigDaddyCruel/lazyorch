import { describe, expect, it } from "vitest";
import {
  applyHostPressure,
  clampInt,
  computeDesiredWorkers,
  decideScale,
  idleDrainCandidates,
} from "./elasticity.js";
import type { SchedulerSession } from "./types.js";

const elasticity = {
  min_workers: 0,
  max_workers: 4,
  scale_up_ready_ratio: 2,
  scale_down_idle_minutes: 10,
  cooldown_seconds: 60,
  scale_burst: 1,
  pressure_scale_down: true,
};

describe("clampInt", () => {
  it("clamps into range", () => {
    expect(clampInt(5, 0, 4)).toBe(4);
    expect(clampInt(-1, 0, 4)).toBe(0);
    expect(clampInt(2, 0, 4)).toBe(2);
  });
});

describe("computeDesiredWorkers", () => {
  it("desired = clamp(ceil(ready / ratio), min, max)", () => {
    // ready=5, ratio=2 → ceil(2.5)=3
    expect(
      computeDesiredWorkers({
        ready_count: 5,
        active_workers: 0,
        elasticity,
      }),
    ).toBe(3);

    // ready=1 → ceil(0.5)=1
    expect(
      computeDesiredWorkers({
        ready_count: 1,
        active_workers: 0,
        elasticity,
      }),
    ).toBe(1);

    // ready=0 → 0 (min_workers)
    expect(
      computeDesiredWorkers({
        ready_count: 0,
        active_workers: 0,
        elasticity,
      }),
    ).toBe(0);

    // ready=100 → capped at max_workers 4
    expect(
      computeDesiredWorkers({
        ready_count: 100,
        active_workers: 0,
        elasticity,
      }),
    ).toBe(4);
  });

  it("budget_exhausted forces desired = 0", () => {
    expect(
      computeDesiredWorkers({
        ready_count: 10,
        active_workers: 2,
        elasticity,
        budget_exhausted: true,
      }),
    ).toBe(0);
  });

  it("host pressure blocks scale-up", () => {
    expect(
      computeDesiredWorkers({
        ready_count: 10,
        active_workers: 2,
        elasticity,
        host: { mem_pct: 91 },
      }),
    ).toBe(2);
  });

  it("severe mem pressure scales down idle capacity by 1", () => {
    expect(
      computeDesiredWorkers({
        ready_count: 10,
        active_workers: 3,
        elasticity,
        host: { mem_pct: 96 },
      }),
    ).toBe(2); // max(0, 3-1)
  });

  it("respects min_workers floor under pressure scale-down", () => {
    const el = { ...elasticity, min_workers: 2 };
    expect(
      computeDesiredWorkers({
        ready_count: 0,
        active_workers: 2,
        elasticity: el,
        host: { mem_pct: 96 },
      }),
    ).toBe(2);
  });
});

describe("applyHostPressure", () => {
  it("cpu > 95 also blocks scale-up", () => {
    expect(
      applyHostPressure(4, 1, 0, { cpu_pct: 96 }, true),
    ).toBe(1);
  });
});

describe("decideScale", () => {
  const base = {
    elasticity,
    free_for_workers: 4,
    now_ms: 120_000,
    last_scale_ms: 0,
    idle_drain_candidates: [] as SchedulerSession[],
  };

  it("spawns min(gap, scale_burst, free, room) on scale-up", () => {
    const d = decideScale({
      ...base,
      desired: 3,
      active_workers: 0,
    });
    expect(d.action).toBe("spawn");
    expect(d.spawn_count).toBe(1); // scale_burst default 1
    expect(d.reason).toBe("scale_up");
  });

  it("respects cooldown", () => {
    const d = decideScale({
      ...base,
      desired: 3,
      active_workers: 0,
      last_scale_ms: 100_000,
      now_ms: 120_000, // 20s < 60s cooldown
    });
    expect(d.action).toBe("none");
    expect(d.reason).toBe("cooldown");
  });

  it("does not spawn without free slots", () => {
    const d = decideScale({
      ...base,
      desired: 2,
      active_workers: 0,
      free_for_workers: 0,
    });
    expect(d.action).toBe("none");
    expect(d.reason).toBe("no_free_slots");
  });

  it("drains only idle clean workers", () => {
    const idle: SchedulerSession = {
      run_handle: "idle1",
      agent_id: "agt_1",
      role: "worker",
      state: "idle",
      worktree_clean: true,
      last_activity_ms: 0,
    };
    const d = decideScale({
      ...base,
      desired: 0,
      active_workers: 1,
      idle_drain_candidates: [idle],
    });
    expect(d.action).toBe("drain");
    expect(d.drain_handles).toEqual(["idle1"]);
  });

  it("never drains busy workers (no idle candidates)", () => {
    const d = decideScale({
      ...base,
      desired: 0,
      active_workers: 2,
      idle_drain_candidates: [],
    });
    expect(d.action).toBe("none");
    expect(d.reason).toBe("no_idle_clean_workers");
  });

  it("pauses elasticity on scale-up when requested", () => {
    const d = decideScale({
      ...base,
      desired: 3,
      active_workers: 0,
      pause_elasticity: true,
    });
    expect(d.action).toBe("none");
    expect(d.reason).toBe("elasticity_paused");
  });

  it("pauses elasticity on scale-down when requested (strict freeze)", () => {
    const idle: SchedulerSession = {
      run_handle: "idle1",
      agent_id: "agt_1",
      role: "worker",
      state: "idle",
      worktree_clean: true,
      last_activity_ms: 0,
    };
    const d = decideScale({
      ...base,
      desired: 0,
      active_workers: 1,
      idle_drain_candidates: [idle],
      pause_elasticity: true,
    });
    expect(d.action).toBe("none");
    expect(d.reason).toBe("elasticity_paused");
  });
});

describe("idleDrainCandidates", () => {
  it("filters by idle + clean + idle time + no task", () => {
    const now = 1_000_000;
    const sessions: SchedulerSession[] = [
      {
        run_handle: "ok",
        agent_id: "a",
        role: "worker",
        state: "idle",
        worktree_clean: true,
        last_activity_ms: now - 11 * 60_000,
      },
      {
        run_handle: "busy",
        agent_id: "b",
        role: "worker",
        state: "running",
        task_id: "tsk_1",
        worktree_clean: true,
        last_activity_ms: now - 11 * 60_000,
      },
      {
        run_handle: "dirty",
        agent_id: "c",
        role: "worker",
        state: "idle",
        worktree_clean: false,
        last_activity_ms: now - 11 * 60_000,
      },
      {
        run_handle: "fresh",
        agent_id: "d",
        role: "worker",
        state: "idle",
        worktree_clean: true,
        last_activity_ms: now - 60_000, // only 1 min idle
      },
    ];
    const got = idleDrainCandidates(sessions, 10, now);
    expect(got.map((s) => s.run_handle)).toEqual(["ok"]);
  });
});
