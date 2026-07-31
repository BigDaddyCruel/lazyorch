import { describe, expect, it } from "vitest";
import {
  createFakeIntegrateGitRunner,
  integrateTaskBranch,
} from "./integrate.js";
import { IntegrationMutex } from "./integrate-mutex.js";

describe("integrateTaskBranch", () => {
  it("merges successfully with fake git", async () => {
    const git = createFakeIntegrateGitRunner({
      tipSha: "deadbeef",
      mergeOutcomes: ["ok"],
    });
    const r = await integrateTaskBranch({
      repoRoot: "/tmp/repo",
      runId: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
      taskId: "tsk_bbbbbbbbbbbbbbbbbbbbbbbb",
      git,
    });
    expect(r.status).toBe("ok");
    expect(r.feature_tip_sha).toBe("deadbeef");
    expect(r.conflict).toBeUndefined();
  });

  it("returns conflict and aborts merge", async () => {
    const git = createFakeIntegrateGitRunner({
      mergeOutcomes: ["conflict"],
    });
    const r = await integrateTaskBranch({
      repoRoot: "/tmp/repo",
      runId: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
      taskId: "tsk_bbbbbbbbbbbbbbbbbbbbbbbb",
      git,
    });
    expect(r.status).toBe("conflict");
    expect(r.conflict).toBe(true);
    expect(r.commands.some((c) => c[0] === "merge" && c[1] === "--abort")).toBe(
      true,
    );
  });

  it("dryRun does not call git", async () => {
    let called = 0;
    const git = async () => {
      called += 1;
      return { stdout: "", stderr: "", code: 0 };
    };
    const r = await integrateTaskBranch({
      repoRoot: "/tmp/repo",
      runId: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
      taskId: "tsk_bbbbbbbbbbbbbbbbbbbbbbbb",
      git,
      dryRun: true,
    });
    expect(r.status).toBe("ok");
    expect(r.dryRun).toBe(true);
    expect(called).toBe(0);
  });

  it("works under IntegrationMutex (daemon pattern)", async () => {
    const mutex = new IntegrationMutex();
    const runId = "run_aaaaaaaaaaaaaaaaaaaaaaaa";
    const taskId = "tsk_bbbbbbbbbbbbbbbbbbbbbbbb";
    expect(mutex.tryAcquire(runId, taskId).ok).toBe(true);
    const r = await integrateTaskBranch({
      repoRoot: "/tmp/repo",
      runId,
      taskId,
      git: createFakeIntegrateGitRunner(),
    });
    expect(r.status).toBe("ok");
    mutex.release(runId);
    expect(mutex.isHeld(runId)).toBe(false);
  });
});
