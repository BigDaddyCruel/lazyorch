import { describe, expect, it } from "vitest";
import { IntegrationMutex } from "./integrate-mutex.js";

describe("IntegrationMutex", () => {
  it("acquires and releases per run", () => {
    const m = new IntegrationMutex();
    expect(m.tryAcquire("run_1", "tsk_a")).toEqual({ ok: true });
    expect(m.holder("run_1")).toBe("tsk_a");
    expect(m.isHeld("run_1")).toBe(true);
    expect(m.release("run_1")).toBe(true);
    expect(m.isHeld("run_1")).toBe(false);
  });

  it("serializes two tasks on same run", () => {
    const m = new IntegrationMutex();
    expect(m.tryAcquire("run_1", "tsk_a").ok).toBe(true);
    const second = m.tryAcquire("run_1", "tsk_b");
    expect(second).toEqual({ ok: false, holder: "tsk_a" });
    m.release("run_1");
    expect(m.tryAcquire("run_1", "tsk_b").ok).toBe(true);
  });

  it("re-acquire by same task is idempotent", () => {
    const m = new IntegrationMutex();
    m.tryAcquire("run_1", "tsk_a");
    expect(m.tryAcquire("run_1", "tsk_a")).toEqual({ ok: true });
  });

  it("allows concurrent integrates across different runs", () => {
    const m = new IntegrationMutex();
    expect(m.tryAcquire("run_1", "tsk_a").ok).toBe(true);
    expect(m.tryAcquire("run_2", "tsk_b").ok).toBe(true);
  });

  it("releaseIfHolder only releases matching task", () => {
    const m = new IntegrationMutex();
    m.tryAcquire("run_1", "tsk_a");
    expect(m.releaseIfHolder("run_1", "tsk_b")).toBe(false);
    expect(m.isHeld("run_1")).toBe(true);
    expect(m.releaseIfHolder("run_1", "tsk_a")).toBe(true);
  });
});
