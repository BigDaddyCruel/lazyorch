import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../schema.js";
import type { Run } from "../types/run.js";
import {
  applyIssueUpdates,
  forceApproveResidual,
  PlanningError,
  runConsensus,
} from "./consensus.js";
import { FakePlanReviewer, FakePlanWriter } from "./fakes.js";
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

  it("returns max_rounds when issues never clear", async () => {
    const artifacts = validArtifacts();
    const openIss = issue({ id: "iss_dddddddddddddddddddddddd" });

    const writer = new FakePlanWriter(
      [],
      () => writeResult(artifacts),
    );
    const reviewer = new FakePlanReviewer(
      [],
      () => ({ issues: [openIss] }),
    );

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
    // Stay in Planning for plan_max_rounds gate
    expect(nextRun.phase).toBe("Planning");
    expect(writer.calls.length).toBe(3); // initial + 2 revises
    expect(reviewer.calls.length).toBe(3);
  });

  it("does not freeze when validators fail even with 0 open issues", async () => {
    // Missing design sections
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

describe("applyIssueUpdates / forceApproveResidual", () => {
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

    const freeze = validateFreeze({
      artifacts: validArtifacts(),
      issues: next,
    });
    expect(freeze.ok).toBe(true);
  });
});
