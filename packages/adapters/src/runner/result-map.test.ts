import { describe, expect, it } from "vitest";
import { mapSessionResultToTaskEffect } from "./result-map.js";
import type { SessionResult } from "../types.js";

function result(partial: Partial<SessionResult> & { status: SessionResult["status"] }): SessionResult {
  return { ...partial, status: partial.status };
}

describe("mapSessionResultToTaskEffect — worker", () => {
  it("maps ok + submitted true → review", () => {
    const e = mapSessionResultToTaskEffect({
      role: "worker",
      session_kind: "llm",
      result: result({
        status: "ok",
        decision: { kind: "worker", submitted: true },
      }),
    });
    expect(e).toMatchObject({ kind: "transition", to: "review" });
  });

  it("maps ok + exit 0 without marker → review", () => {
    const e = mapSessionResultToTaskEffect({
      role: "worker",
      session_kind: "deterministic",
      result: result({ status: "ok", exit_code: 0 }),
    });
    expect(e).toMatchObject({ kind: "transition", to: "review" });
  });

  it("maps submitted false → requeue with attempt++", () => {
    const e = mapSessionResultToTaskEffect({
      role: "worker",
      session_kind: "llm",
      result: result({
        status: "ok",
        decision: { kind: "worker", submitted: false },
      }),
      attempt: 0,
      max_attempts: 3,
    });
    expect(e).toMatchObject({
      kind: "transition",
      to: "ready",
      increment_attempt: true,
    });
  });

  it("maps error at max attempts → failed", () => {
    const e = mapSessionResultToTaskEffect({
      role: "worker",
      session_kind: "llm",
      result: result({ status: "error", exit_code: 1 }),
      attempt: 2,
      max_attempts: 3,
    });
    expect(e).toMatchObject({ kind: "transition", to: "failed" });
  });

  it("maps timeout → requeue", () => {
    const e = mapSessionResultToTaskEffect({
      role: "worker",
      session_kind: "llm",
      result: result({ status: "timeout" }),
      attempt: 0,
      max_attempts: 3,
    });
    expect(e).toMatchObject({
      kind: "transition",
      to: "ready",
      increment_attempt: true,
    });
  });
});

describe("mapSessionResultToTaskEffect — reviewer", () => {
  it("approve → integrating", () => {
    const e = mapSessionResultToTaskEffect({
      role: "reviewer",
      session_kind: "llm",
      result: result({
        status: "ok",
        decision: { kind: "review", decision: "approve" },
      }),
    });
    expect(e).toMatchObject({ kind: "transition", to: "integrating" });
  });

  it("reject → ready", () => {
    const e = mapSessionResultToTaskEffect({
      role: "reviewer",
      session_kind: "llm",
      result: result({
        status: "ok",
        decision: { kind: "review", decision: "reject" },
      }),
    });
    expect(e).toMatchObject({ kind: "transition", to: "ready" });
  });

  it("invalid once → stay review; twice → human_intervention", () => {
    const once = mapSessionResultToTaskEffect({
      role: "reviewer",
      session_kind: "llm",
      result: result({ status: "ok" }),
      invalid_parse_count: 0,
    });
    expect(once.kind).toBe("stay");
    const twice = mapSessionResultToTaskEffect({
      role: "reviewer",
      session_kind: "llm",
      result: result({ status: "ok" }),
      invalid_parse_count: 1,
    });
    expect(twice.kind).toBe("human_intervention");
  });
});

describe("mapSessionResultToTaskEffect — qa / lead", () => {
  it("qa pass / fail", () => {
    const pass = mapSessionResultToTaskEffect({
      role: "qa",
      session_kind: "llm",
      result: result({
        status: "ok",
        decision: { kind: "qa", passed: true, summary: "green" },
      }),
    });
    expect(pass).toMatchObject({ kind: "qa_pass", summary: "green" });

    const fail = mapSessionResultToTaskEffect({
      role: "qa",
      session_kind: "llm",
      result: result({
        status: "ok",
        decision: { kind: "qa", passed: false },
      }),
    });
    expect(fail.kind).toBe("qa_fail");
  });

  it("lead → none", () => {
    const e = mapSessionResultToTaskEffect({
      role: "lead",
      session_kind: "llm",
      result: result({ status: "ok" }),
    });
    expect(e.kind).toBe("none");
  });
});
