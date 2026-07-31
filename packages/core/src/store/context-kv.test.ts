import { describe, expect, it } from "vitest";
import {
  CONTEXT_KEY_MAX_LEN,
  CONTEXT_VALUE_MAX_BYTES,
  ContextKvError,
  assertCanWriteContext,
  assertValidContextKey,
  assertValidContextValue,
  canWriteContext,
  contextSnapshot,
  deleteContextValue,
  emptyRunContext,
  getContextValue,
  isContextActorRole,
  listContextKeys,
  setContextValue,
} from "./context-kv.js";

describe("context-kv keys", () => {
  it("accepts namespaced keys like model_pin/*", () => {
    expect(() => assertValidContextKey("port")).not.toThrow();
    expect(() => assertValidContextKey("model_pin/worker")).not.toThrow();
    expect(() => assertValidContextKey("a.b-c_1/x")).not.toThrow();
  });

  it("rejects empty, relative, and illegal characters", () => {
    expect(() => assertValidContextKey("")).toThrow(ContextKvError);
    expect(() => assertValidContextKey("/leading")).toThrow(ContextKvError);
    expect(() => assertValidContextKey("trailing/")).toThrow(ContextKvError);
    expect(() => assertValidContextKey("a//b")).toThrow(ContextKvError);
    expect(() => assertValidContextKey("a/../b")).toThrow(ContextKvError);
    expect(() => assertValidContextKey("has space")).toThrow(ContextKvError);
    expect(() => assertValidContextKey("a\0b")).toThrow(ContextKvError);
  });

  it("rejects keys longer than max", () => {
    expect(() =>
      assertValidContextKey("k".repeat(CONTEXT_KEY_MAX_LEN + 1)),
    ).toThrow(ContextKvError);
  });
});

describe("context-kv values", () => {
  it("accepts JSON-serializable values", () => {
    expect(() => assertValidContextValue(null)).not.toThrow();
    expect(() => assertValidContextValue(42)).not.toThrow();
    expect(() => assertValidContextValue("hi")).not.toThrow();
    expect(() => assertValidContextValue({ a: [1, true] })).not.toThrow();
  });

  it("rejects undefined and non-serializable", () => {
    expect(() => assertValidContextValue(undefined)).toThrow(ContextKvError);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => assertValidContextValue(cyclic)).toThrow(ContextKvError);
  });

  it("rejects oversized values", () => {
    const big = "x".repeat(CONTEXT_VALUE_MAX_BYTES + 1);
    expect(() => assertValidContextValue(big)).toThrow(ContextKvError);
  });
});

describe("context-kv write ACL", () => {
  it("system, human, lead always write", () => {
    for (const role of ["system", "human", "lead"] as const) {
      expect(canWriteContext(role, false)).toBe(true);
      expect(canWriteContext(role, true)).toBe(true);
      expect(() => assertCanWriteContext(role, false)).not.toThrow();
    }
  });

  it("worker respects worker_write config", () => {
    expect(canWriteContext("worker", false)).toBe(false);
    expect(canWriteContext("worker", true)).toBe(true);
    expect(() => assertCanWriteContext("worker", false)).toThrow(ContextKvError);
    expect(() => assertCanWriteContext("worker", true)).not.toThrow();
  });

  it("reviewer/qa/plan roles are read-only even when worker_write", () => {
    for (const role of [
      "reviewer",
      "qa",
      "plan_writer",
      "plan_reviewer",
    ] as const) {
      expect(canWriteContext(role, false)).toBe(false);
      expect(canWriteContext(role, true)).toBe(false);
    }
  });

  it("isContextActorRole narrows known roles", () => {
    expect(isContextActorRole("lead")).toBe(true);
    expect(isContextActorRole("worker")).toBe(true);
    expect(isContextActorRole("admin")).toBe(false);
    expect(isContextActorRole(1)).toBe(false);
  });
});

describe("context-kv pure ops", () => {
  it("set/get/list/delete round-trip", () => {
    let ctx = emptyRunContext("run_demo");
    expect(listContextKeys(ctx)).toEqual([]);
    expect(contextSnapshot(ctx)).toEqual({});

    ctx = setContextValue(ctx, "port", 7420, "2026-01-01T00:00:00.000Z");
    ctx = setContextValue(ctx, "model_pin/worker", "claude", "2026-01-01T00:00:01.000Z");

    expect(getContextValue(ctx, "port")).toBe(7420);
    expect(getContextValue(ctx, "model_pin/worker")).toBe("claude");
    expect(getContextValue(ctx, "missing")).toBeUndefined();
    expect(listContextKeys(ctx)).toEqual(["model_pin/worker", "port"]);
    expect(contextSnapshot(ctx)).toEqual({
      port: 7420,
      "model_pin/worker": "claude",
    });

    const delMissing = deleteContextValue(ctx, "nope");
    expect(delMissing.deleted).toBe(false);
    expect(delMissing.context).toBe(ctx);

    const del = deleteContextValue(ctx, "port", "2026-01-01T00:00:02.000Z");
    expect(del.deleted).toBe(true);
    expect(getContextValue(del.context, "port")).toBeUndefined();
    expect(listContextKeys(del.context)).toEqual(["model_pin/worker"]);
    expect(del.context.updated_at).toBe("2026-01-01T00:00:02.000Z");
  });
});
