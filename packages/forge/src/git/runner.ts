import { spawn } from "node:child_process";

export interface GitRunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface GitRunOptions {
  cwd?: string;
  /** Extra env vars merged over process.env */
  env?: NodeJS.ProcessEnv;
}

/**
 * Abstraction over `git` invocations so tests can inject a fake runner.
 */
export type GitRunner = (
  args: readonly string[],
  options?: GitRunOptions,
) => Promise<GitRunResult>;

/**
 * Run `git <args>` via child_process (no shell).
 * Does not stash; callers never pass stash-related defaults.
 */
export const realGitRunner: GitRunner = (args, options = {}) => {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args as string[], {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
};

export class GitError extends Error {
  readonly code: number;
  readonly args: readonly string[];
  readonly stdout: string;
  readonly stderr: string;

  constructor(
    message: string,
    opts: {
      code: number;
      args: readonly string[];
      stdout: string;
      stderr: string;
    },
  ) {
    super(message);
    this.name = "GitError";
    this.code = opts.code;
    this.args = opts.args;
    this.stdout = opts.stdout;
    this.stderr = opts.stderr;
  }
}

/** Run git and throw GitError on non-zero exit. */
export async function gitOk(
  runner: GitRunner,
  args: readonly string[],
  options?: GitRunOptions,
): Promise<GitRunResult> {
  const result = await runner(args, options);
  if (result.code !== 0) {
    throw new GitError(
      `git ${args.join(" ")} failed (exit ${result.code}): ${result.stderr || result.stdout}`,
      { code: result.code, args, stdout: result.stdout, stderr: result.stderr },
    );
  }
  return result;
}
