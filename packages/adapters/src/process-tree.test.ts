import { describe, expect, it } from "vitest";
import { killProcessTree } from "./process-tree.js";

describe("killProcessTree", () => {
  it("no-ops for invalid pids", async () => {
    await expect(killProcessTree(0)).resolves.toBeUndefined();
    await expect(killProcessTree(-1)).resolves.toBeUndefined();
  });

  it("uses taskkill on win32", async () => {
    const calls: { cmd: string; args: readonly string[] }[] = [];
    await killProcessTree(1234, {
      platform: "win32",
      run: async (cmd, args) => {
        calls.push({ cmd, args });
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    expect(calls).toEqual([
      { cmd: "taskkill", args: ["/T", "/F", "/PID", "1234"] },
    ]);
  });

  it("uses process group signals on posix", async () => {
    const signals: { pid: number; signal?: NodeJS.Signals | number }[] = [];
    await killProcessTree(42, {
      platform: "linux",
      grace_ms: 0,
      killPid: (pid, signal) => {
        signals.push({ pid, signal });
      },
    });
    expect(signals.some((s) => s.pid === -42 && s.signal === "SIGTERM")).toBe(
      true,
    );
    expect(signals.some((s) => s.pid === -42 && s.signal === "SIGKILL")).toBe(
      true,
    );
  });
});
