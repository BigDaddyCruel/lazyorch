import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../schema.js";
import type { Run } from "../types/run.js";
import {
  applyIssueUpdates,
  completeForceApprove,
  detectPlanDispute,
  forceApproveResidual,
  PlanningError,
  residualRisksFromIssues,
  runConsensus,
} from "./consensus.js";
import { FakePlanReviewer, FakePlanWriter } from "./fakes.js";
import { computeFreezeHash } from "./materialize.js";
import {
  draftTask,
  issue,
  validArtifacts,
  writeResult,
} from "./test-fixtures.js";
import { validateFreeze } from "./validators.js";

function run(phase: Run["phase"] = "Planning"): Run {
  return {
    schema_version: SCHEMA_VERSION,
    id: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
    project_id: "proj",
    phase,
    idea: "build planning engine",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

const FIXED = "2026-02-01T00:00:00.000Z";

describe("runConsensus", () => {
  it("freezes on first round when reviewer finds no issues", async () => {
    const artifacts = validArtifacts();
    const writer = new FakePlanWriter([writeResult(artifacts)]);
    const reviewer = new FakePlanReviewer([{ issues: [] }]);

    const { result, run: nextRun } = await runConsensus({
      run: run(),
      writer,
      reviewer,
      now: () => FIXED,
      plan_id: "plan_bbbbbbbbbbbbbbbbbbbbbbbb",
    });

    expect(result.status).toBe("frozen");
    if (result.status !== "frozen") return;
    expect(result.rounds).toBe(1);
    expect(result.plan.status).toBe("frozen");
    expect(result.plan.freeze_hash).toBe(result.freeze_hash);
    expect(result.plan.freeze_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks.every((t) => t.status === "todo")).toBe(true);
    expect(result.tasks.every((t) => t.origin === "plan")).toBe(true);
    expect(nextRun.phase).toBe("PlanConsensus");
    expect(nextRun.plan_id).toBe("plan_bbbbbbbbbbbbbbbbbbbbbbbb");
    expect(writer.calls).toHaveLength(1);
    expect(reviewer.calls).toHaveLength(1);
  });

  it("revises until open issues are cleared", async () => {
    const v1 = validArtifacts([draftTask("tsk_a")]);
    const v2 = validArtifacts([
      draftTask("tsk_a"),
      draftTask("tsk_b", { depends_on: ["tsk_a"] }),
    ]);
    const openIss = issue({
      id: "iss_cccccccccccccccccccccccc",
      description: "Need second task",
    });

    const writer = new FakePlanWriter([
      writeResult(v1),
      writeResult(v2, [
        {
          issue_id: openIss.id,
          status: "addressed",
          response: "Added tsk_b",
        },
      ]),
    ]);
    const reviewer = new FakePlanReviewer([
      { issues: [openIss] },
      {
        issues: [
          {
            ...openIss,
            status: "addressed",
            response: "Added tsk_b",
            updated_at: FIXED,
          },
        ],
      },
    ]);

    const { result } = await runConsensus({
      run: run(),
      writer,
      reviewer,
      now: () => FIXED,
      config: { max_rounds: 5 },
    });

    expect(result.status).toBe("frozen");
    if (result.status !== "frozen") return;
    expect(result.rounds).toBe(2);
    expect(result.tasks.map((t) => t.id).sort()).toEqual(["tsk_a", "tsk_b"]);
    expect(writer.calls).toHaveLength(2);
    expect(writer.calls[1]?.open_issues).toHaveLength(1);
    expect(writer.calls[1]?.previous).toEqual(v1);
    expect(reviewer.calls).toHaveLength(2);
  });

  it("passes validation_errors to writer on revise when freeze fails", async () => {
    const bad = {
      design_md: "# Only title\n",
      task_dag: { tasks: [draftTask("tsk_a")] },
      pr_plan_md: "tsk_a",
    };
    const good = validArtifacts([draftTask("tsk_a")]);
    const writer = new FakePlanWriter([writeResult(bad), writeResult(good)]);
    const reviewer = new FakePlanReviewer([{ issues: [] }, { issues: [] }]);

    const { result } = await runConsensus({
      run: run(),
      writer,
      reviewer,
      now: () => FIXED,
      config: { max_rounds: 3 },
    });

    expect(result.status).toBe("frozen");
    expect(writer.calls).toHaveLength(2);
    expect(writer.calls[1]?.validation_errors?.length).toBeGreaterThan(0);
    expect(
      writer.calls[1]?.validation_errors?.some(
        (e) => e.code === "missing_section",
      ),
    ).toBe(true);
  });

  it("returns max_rounds when issues never clear", async () => {
    const artifacts = validArtifacts();
    const openIss = issue({ id: "iss_dddddddddddddddddddddddd" });

    const writer = new FakePlanWriter([], () => writeResult(artifacts));
    const reviewer = new FakePlanReviewer([], () => ({ issues: [openIss] }));

    const { result, run: nextRun } = await runConsensus({
      run: run(),
      writer,
      reviewer,
      now: () => FIXED,
      config: { max_rounds: 3 },
    });

    expect(result.status).toBe("max_rounds");
    if (result.status !== "max_rounds") return;
    expect(result.rounds).toBe(3);
    expect(result.open_issues).toBe(1);
    expect(result.plan.status).toBe("in_review");
    expect(result.validation_errors.some((e) => e.code === "open_issues")).toBe(
      true,
    );
    expect(nextRun.phase).toBe("Planning");
    expect(writer.calls.length).toBe(3);
    expect(reviewer.calls.length).toBe(3);
  });

  it("does not freeze when validators fail even with 0 open issues", async () => {
    const bad = {
      design_md: "# Only title\n",
      task_dag: { tasks: [draftTask("tsk_a")] },
      pr_plan_md: "tsk_a",
    };
    const writer = new FakePlanWriter([writeResult(bad)]);
    const reviewer = new FakePlanReviewer([{ issues: [] }]);

    const { result } = await runConsensus({
      run: run(),
      writer,
      reviewer,
      now: () => FIXED,
      config: { max_rounds: 1 },
    });

    expect(result.status).toBe("max_rounds");
    if (result.status !== "max_rounds") return;
    expect(result.open_issues).toBe(0);
    expect(
      result.validation_errors.some((e) => e.code === "missing_section"),
    ).toBe(true);
  });

  it("returns dispute when reviewer re-opens wontfix at high severity", async () => {
    const artifacts = validArtifacts();
    const issId = "iss_eeeeeeeeeeeeeeeeeeeeeeee";
    const writer = new FakePlanWriter([
      writeResult(artifacts),
      writeResult(artifacts, [
        {
          issue_id: issId,
          status: "wontfix",
          response: "out of scope",
        },
      ]),
    ]);
    const reviewer = new FakePlanReviewer([
      {
        issues: [
          issue({
            id: issId,
            status: "open",
            severity: "high",
            description: "Need X",
          }),
        ],
      },
      {
        issues: [
          issue({
            id: issId,
            status: "open",
            severity: "critical",
            description: "Still need X",
          }),
        ],
      },
    ]);

    const { result, run: nextRun } = await runConsensus({
      run: run(),
      writer,
      reviewer,
      now: () => FIXED,
      config: { max_rounds: 5 },
    });

    expect(result.status).toBe("dispute");
    if (result.status !== "dispute") return;
    expect(result.disputed_issue_ids).toEqual([issId]);
    expect(nextRun.phase).toBe("Planning");
  });

  it("wraps writer failures as PlanningError", async () => {
    const writer = new FakePlanWriter();
    writer.setHandler(() => {
      throw new Error("llm timeout");
    });
    const reviewer = new FakePlanReviewer([{ issues: [] }]);
    await expect(
      runConsensus({ run: run(), writer, reviewer, now: () => FIXED }),
    ).rejects.toMatchObject({ name: "PlanningError", code: "writer" });
  });

  it("wraps reviewer failures as PlanningError", async () => {
    const writer = new FakePlanWriter([writeResult()]);
    const reviewer = new FakePlanReviewer();
    reviewer.setHandler(() => {
      throw new Error("review boom");
    });
    await expect(
      runConsensus({ run: run(), writer, reviewer, now: () => FIXED }),
    ).rejects.toMatchObject({ name: "PlanningError", code: "reviewer" });
  });

  it("accepts Inception and transitions into Planning", async () => {
    const writer = new FakePlanWriter([writeResult()]);
    const reviewer = new FakePlanReviewer([{ issues: [] }]);
    const { run: nextRun, result } = await runConsensus({
      run: run("Inception"),
      writer,
      reviewer,
      now: () => FIXED,
    });
    expect(result.status).toBe("frozen");
    expect(nextRun.phase).toBe("PlanConsensus");
  });

  it("rejects invalid phases", async () => {
    const writer = new FakePlanWriter([writeResult()]);
    const reviewer = new FakePlanReviewer([{ issues: [] }]);
    await expect(
      runConsensus({
        run: run("Implementing"),
        writer,
        reviewer,
      }),
    ).rejects.toBeInstanceOf(PlanningError);
  });

  it("supports handler-based fakes", async () => {
    const writer = new FakePlanWriter();
    writer.setHandler(() => writeResult());
    const reviewer = new FakePlanReviewer();
    reviewer.setHandler(() => ({ issues: [] }));
    const { result } = await runConsensus({
      run: run(),
      writer,
      reviewer,
      now: () => FIXED,
    });
    expect(result.status).toBe("frozen");
  });
});

describe("applyIssueUpdates / forceApprove / dispute helpers", () => {
  it("applies addressed updates", () => {
    const issues = [issue({ id: "iss_1", status: "open" })];
    const next = applyIssueUpdates(
      issues,
      [{ issue_id: "iss_1", status: "addressed", response: "fixed" }],
      FIXED,
    );
    expect(next[0]?.status).toBe("addressed");
    expect(next[0]?.response).toBe("fixed");
  });

  it("force-approves residual open issues", () => {
    const issues = [
      issue({ id: "iss_1", status: "open" }),
      issue({ id: "iss_2", status: "needs-user-input" }),
      issue({ id: "iss_3", status: "addressed", response: "ok" }),
    ];
    const next = forceApproveResidual(issues, FIXED);
    expect(next[0]?.status).toBe("wontfix");
    expect(next[0]?.response).toBe("force_approve residual");
    expect(next[1]?.status).toBe("wontfix");
    expect(next[2]?.status).toBe("addressed");
    expect(residualRisksFromIssues(next)).toHaveLength(2);

    const freeze = validateFreeze({
      artifacts: validArtifacts(),
      issues: next,
    });
    expect(freeze.ok).toBe(true);
  });

  it("completeForceApprove freezes with residual_risks", () => {
    const artifacts = validArtifacts();
    const out = completeForceApprove({
      run: run(),
      artifacts,
      issues: [issue({ id: "iss_1", status: "open", description: "risk" })],
      plan_id: "plan_ffffffffffffffffffffffff",
      revision: 3,
      now: () => FIXED,
      rounds: 5,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.status).toBe("frozen");
    expect(out.result.plan.residual_risks?.length).toBe(1);
    expect(out.result.plan.freeze_hash).toBe(
      computeFreezeHash(artifacts, out.result.plan.issues),
    );
    expect(out.run.phase).toBe("PlanConsensus");
  });

  it("detectPlanDispute finds high re-opens of wontfix", () => {
    const prior = new Set(["iss_1"]);
    const ids = detectPlanDispute(prior, [
      issue({ id: "iss_1", status: "open", severity: "high" }),
      issue({ id: "iss_2", status: "open", severity: "low" }),
    ]);
    expect(ids).toEqual(["iss_1"]);
  });
});
