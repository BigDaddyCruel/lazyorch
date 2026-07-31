import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFakeGitRunner,
  createWorktree,
  defaultWorktreeRoot,
  featureBranchName,
  hashRepoRoot,
  isWorktreeClean,
  normalizeRepoRootForHash,
  removeWorktree,
  resolveWorktreePaths,
  taskBranchName,
} from "./worktree.js";
import { GitError } from "./runner.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) await rm(d, { recursive: true, force: true });
  }
});

async function makeTempRoot(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "lazyorch-forge-"));
  tempDirs.push(d);
  return d;
}

describe("branch names", () => {
  it("builds feature and task branch names", () => {
    expect(featureBranchName("run_abc")).toBe("lazyorch/run_abc/feature");
    expect(taskBranchName("run_abc", "tsk_1")).toBe("lazyorch/run_abc/tsk_1");
  });

  it("rejects unsafe ids", () => {
    expect(() => taskBranchName("run/x", "tsk_1")).toThrow(/runId/);
    expect(() => taskBranchName("run_x", "../etc")).toThrow(/taskId/);
    expect(() => featureBranchName("..")).toThrow(/runId/);
    expect(() => taskBranchName("run_x", "tsk:bad")).toThrow(/taskId/);
    expect(() => taskBranchName("run_x", "tsk*bad")).toThrow(/taskId/);
  });
});

describe("defaultWorktreeRoot", () => {
  const repo = resolve("/repo/myproj");

  it("uses in-repo .lazyorch/worktrees on non-Windows", () => {
    expect(defaultWorktreeRoot(repo, undefined, "linux")).toBe(
      join(repo, ".lazyorch", "worktrees"),
    );
  });

  it("uses external USERPROFILE root on Windows", () => {
    const prev = process.env.USERPROFILE;
    process.env.USERPROFILE = "C:\\Users\\Test";
    try {
      const root = defaultWorktreeRoot(repo, "deadbeef", "win32");
      expect(root.replace(/\\/g, "/")).toBe(
        "C:/Users/Test/.lazyorch/worktrees/deadbeef",
      );
    } finally {
      if (prev === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prev;
    }
  });

  it("falls back to in-repo when only bare HOMEPATH is set on Windows", () => {
    const prevProfile = process.env.USERPROFILE;
    const prevHome = process.env.HOME;
    const prevPath = process.env.HOMEPATH;
    const prevDrive = process.env.HOMEDRIVE;
    delete process.env.USERPROFILE;
    delete process.env.HOME;
    delete process.env.HOMEDRIVE;
    process.env.HOMEPATH = "\\Users\\Test";
    try {
      const root = defaultWorktreeRoot(repo, "deadbeef", "win32");
      expect(root).toBe(join(repo, ".lazyorch", "worktrees"));
    } finally {
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevPath === undefined) delete process.env.HOMEPATH;
      else process.env.HOMEPATH = prevPath;
      if (prevDrive === undefined) delete process.env.HOMEDRIVE;
      else process.env.HOMEDRIVE = prevDrive;
    }
  });

  it("uses HOMEDRIVE+HOMEPATH when USERPROFILE is missing", () => {
    const prevProfile = process.env.USERPROFILE;
    const prevDrive = process.env.HOMEDRIVE;
    const prevPath = process.env.HOMEPATH;
    delete process.env.USERPROFILE;
    process.env.HOMEDRIVE = "D:";
    process.env.HOMEPATH = "\\Users\\Alt";
    try {
      const root = defaultWorktreeRoot(repo, "abc123", "win32");
      expect(root.replace(/\\/g, "/")).toBe(
        "D:/Users/Alt/.lazyorch/worktrees/abc123",
      );
    } finally {
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
      if (prevDrive === undefined) delete process.env.HOMEDRIVE;
      else process.env.HOMEDRIVE = prevDrive;
      if (prevPath === undefined) delete process.env.HOMEPATH;
      else process.env.HOMEPATH = prevPath;
    }
  });

  it("hashes repo root when projectHash omitted", () => {
    expect(hashRepoRoot(repo)).toMatch(/^[0-9a-f]{12}$/);
    expect(hashRepoRoot(repo)).toBe(hashRepoRoot(repo));
  });

  it("hashes Windows drive paths case-insensitively", () => {
    expect(normalizeRepoRootForHash("C:\\Users\\x\\repo")).toBe(
      normalizeRepoRootForHash("c:\\Users\\x\\repo"),
    );
    expect(hashRepoRoot("C:\\Users\\x\\repo")).toBe(
      hashRepoRoot("c:\\Users\\x\\repo"),
    );
    expect(hashRepoRoot("C:/Users/x/repo/")).toBe(
      hashRepoRoot("c:\\Users\\x\\repo"),
    );
  });
});

describe("resolveWorktreePaths", () => {
  it("resolves under custom worktree_root", () => {
    const p = resolveWorktreePaths({
      repoRoot: "/repo",
      taskId: "tsk_abc",
      runId: "run_1",
      worktreeRoot: "/wt",
    });
    expect(p.branch).toBe("lazyorch/run_1/tsk_abc");
    expect(p.worktreePath).toBe(resolve("/wt/tsk_abc"));
    expect(p.worktreeRoot).toBe(resolve("/wt"));
  });

  it("resolves relative worktree_root against repo", () => {
    const repo = resolve("/repo");
    const p = resolveWorktreePaths({
      repoRoot: repo,
      taskId: "tsk_1",
      runId: "run_1",
      worktreeRoot: ".custom-wt",
    });
    expect(p.worktreeRoot).toBe(join(repo, ".custom-wt"));
    expect(p.worktreePath).toBe(join(repo, ".custom-wt", "tsk_1"));
  });

  it("uses Windows external root layout when platform is win32", () => {
    const prev = process.env.USERPROFILE;
    process.env.USERPROFILE = "C:\\Users\\Test";
    try {
      const p = resolveWorktreePaths(
        {
          repoRoot: "C:\\repo\\proj",
          taskId: "tsk_abc",
          runId: "run_1",
          projectHash: "deadbeefcafe",
        },
        "win32",
      );
      expect(p.worktreeRoot.replace(/\\/g, "/")).toBe(
        "C:/Users/Test/.lazyorch/worktrees/deadbeefcafe",
      );
      expect(p.worktreePath.replace(/\\/g, "/")).toBe(
        "C:/Users/Test/.lazyorch/worktrees/deadbeefcafe/tsk_abc",
      );
      expect(p.branch).toBe("lazyorch/run_1/tsk_abc");
    } finally {
      if (prev === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prev;
    }
  });
});

describe("createWorktree / removeWorktree (fake git)", () => {
  it("dry-run create returns commands without calling git", async () => {
    const git = createFakeGitRunner();
    const result = await createWorktree({
      repoRoot: resolve("/repo"),
      taskId: "tsk_1",
      runId: "run_1",
      worktreeRoot: resolve("/wt"),
      baseRef: "lazyorch/run_1/feature",
      dryRun: true,
      git,
    });
    expect(result.dryRun).toBe(true);
    expect(result.branch).toBe("lazyorch/run_1/tsk_1");
    expect(result.commands).toEqual([
      [
        "worktree",
        "add",
        "-b",
        "lazyorch/run_1/tsk_1",
        result.worktreePath,
        "lazyorch/run_1/feature",
      ],
    ]);
    expect(git.calls).toHaveLength(0);
  });

  it("create invokes git worktree add -b (no stash)", async () => {
    const git = createFakeGitRunner();
    const repo = await makeTempRoot();
    const wtRoot = await makeTempRoot();
    const result = await createWorktree({
      repoRoot: repo,
      taskId: "tsk_2",
      runId: "run_9",
      worktreeRoot: wtRoot,
      git,
    });
    expect(result.dryRun).toBe(false);
    expect(git.calls).toHaveLength(1);
    const call = git.calls[0]!;
    expect(call.args[0]).toBe("worktree");
    expect(call.args[1]).toBe("add");
    expect(call.args).toContain("-b");
    expect(call.args).not.toContain("stash");
    expect(call.cwd).toBe(repo);
  });

  it("remove without force does not stash; can delete branch", async () => {
    const git = createFakeGitRunner();
    const repo = await makeTempRoot();
    const wt = join(await makeTempRoot(), "tsk_2");
    const result = await removeWorktree({
      repoRoot: repo,
      worktreePath: wt,
      branch: "lazyorch/run_9/tsk_2",
      deleteBranch: true,
      git,
    });
    expect(result.commands).toEqual([
      ["worktree", "remove", resolve(wt)],
      ["branch", "-d", "lazyorch/run_9/tsk_2"],
    ]);
    expect(git.calls.map((c) => c.args[0])).toEqual(["worktree", "branch"]);
    for (const c of git.calls) {
      expect(c.args).not.toContain("stash");
    }
  });

  it("remove force does not force-delete branch", async () => {
    const git = createFakeGitRunner();
    const wt = join(await makeTempRoot(), "tsk_x");
    await removeWorktree({
      repoRoot: await makeTempRoot(),
      worktreePath: wt,
      branch: "lazyorch/run_x/tsk_x",
      deleteBranch: true,
      force: true,
      git,
    });
    expect(git.calls[0]?.args).toContain("--force");
    expect(git.calls[1]?.args).toContain("-d");
    expect(git.calls[1]?.args).not.toContain("-D");
  });

  it("forceBranch uses -D for branch delete", async () => {
    const git = createFakeGitRunner();
    const wt = join(await makeTempRoot(), "tsk_y");
    await removeWorktree({
      repoRoot: await makeTempRoot(),
      worktreePath: wt,
      branch: "lazyorch/run_y/tsk_y",
      deleteBranch: true,
      forceBranch: true,
      git,
    });
    expect(git.calls[0]?.args).not.toContain("--force");
    expect(git.calls[1]?.args).toContain("-D");
  });

  it("propagates git failures", async () => {
    const git = createFakeGitRunner({
      failArgsPrefix: ["worktree", "add"],
      failCode: 128,
    });
    await expect(
      createWorktree({
        repoRoot: await makeTempRoot(),
        taskId: "tsk_1",
        runId: "run_1",
        worktreeRoot: await makeTempRoot(),
        git,
      }),
    ).rejects.toBeInstanceOf(GitError);
  });
});

describe("isWorktreeClean", () => {
  it("true when porcelain empty", async () => {
    const git = createFakeGitRunner({ statusPorcelain: "" });
    await expect(isWorktreeClean("/wt/t", git)).resolves.toBe(true);
  });

  it("false when dirty (no auto-stash)", async () => {
    const git = createFakeGitRunner({
      statusPorcelain: " M src/a.ts\n",
    });
    await expect(isWorktreeClean("/wt/t", git)).resolves.toBe(false);
    expect(git.calls[0]?.args).toEqual(["status", "--porcelain"]);
    expect(git.calls[0]?.args).not.toContain("stash");
  });
});
