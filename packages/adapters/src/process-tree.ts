/**
 * Cross-platform process-tree kill for session cancel / timeout / stall.
 * Windows: `taskkill /T /F /PID <pid>`
 * POSIX: SIGTERM then SIGKILL on the process group when possible.
 */

import { spawn } from "node:child_process";

export interface KillTreeOptions {
  /** Grace before force-kill on POSIX (ms). Default 0 (immediate SIGKILL after TERM). */
  grace_ms?: number;
  /** Injected runner for tests. */
  run?: (
    command: string,
    args: readonly string[],
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** Injected process.kill for tests. */
  killPid?: (pid: number, signal?: NodeJS.Signals | number) => void;
  platform?: NodeJS.Platform;
}

function defaultRun(
  command: string,
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args as string[], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => {
      stdout += c;
    });
    child.stderr?.on("data", (c: string) => {
      stderr += c;
    });
    child.on("error", (err) => {
      resolve({ code: 1, stdout, stderr: String(err) });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Kill a process tree. Best-effort; never throws for "already dead".
 */
export async function killProcessTree(
  pid: number,
  options: KillTreeOptions = {},
): Promise<void> {
  if (!Number.isFinite(pid) || pid <= 0) return;

  const platform = options.platform ?? process.platform;
  const run = options.run ?? defaultRun;
  const killPid =
    options.killPid ??
    ((p: number, signal?: NodeJS.Signals | number) => {
      try {
        process.kill(p, signal);
      } catch {
        // ESRCH etc. — already gone
      }
    });

  if (platform === "win32") {
    await run("taskkill", ["/T", "/F", "/PID", String(pid)]);
    return;
  }

  // Prefer process-group kill when the child was spawned detached (group leader).
  const grace = options.grace_ms ?? 0;
  try {
    killPid(-pid, "SIGTERM");
  } catch {
    killPid(pid, "SIGTERM");
  }
  if (grace > 0) await sleep(grace);
  try {
    killPid(-pid, "SIGKILL");
  } catch {
    killPid(pid, "SIGKILL");
  }
}
