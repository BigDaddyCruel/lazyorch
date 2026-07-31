import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import {
  acquireDaemonLockExclusive,
  buildLock,
  inspectDaemonLock,
  isPidAlive,
  readDaemonLock,
  removeDaemonLock,
  tryCreateDaemonLockExclusive,
  writeDaemonLock,
  writeDaemonToken,
  readDaemonToken,
} from "./lockfile.js";
import { daemonLockPath, daemonTokenPath } from "./paths.js";
import { access, constants as fsConstants } from "node:fs/promises";

const temps: string[] = [];

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lazyorch-daemon-"));
  temps.push(dir);
  return dir;
}

afterEach(async () => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("lockfile", () => {
  it("isPidAlive for current process", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(0)).toBe(false);
  });

  it("write/read lock and token", async () => {
    const home = await tempHome();
    const { path: tokenPath, token } = await writeDaemonToken(home, "secret-token");
    expect(token).toBe("secret-token");
    expect(await readDaemonToken(home)).toBe("secret-token");

    const lock = buildLock({ port: 7420, tokenPath, pid: process.pid });
    const lockPath = await writeDaemonLock(lock, home);
    expect(lockPath).toBe(daemonLockPath(home));

    const read = await readDaemonLock(home);
    expect(read).toMatchObject({
      pid: process.pid,
      port: 7420,
      host: "127.0.0.1",
      token_path: tokenPath,
      api_major: 1,
    });

    const inspected = await inspectDaemonLock(home);
    expect(inspected.healthy).toBe(true);
    expect(inspected.lock?.port).toBe(7420);
  });

  it("stale pid is unhealthy", async () => {
    const home = await tempHome();
    const { path: tokenPath } = await writeDaemonToken(home);
    // Use a pid that is almost certainly dead
    const lock = buildLock({ port: 7421, tokenPath, pid: 2_147_483_646 });
    await writeDaemonLock(lock, home);
    const inspected = await inspectDaemonLock(home);
    // On some systems pid may coincidentally exist; only assert structure
    expect(inspected.lock?.pid).toBe(2_147_483_646);
    if (!isPidAlive(2_147_483_646)) {
      expect(inspected.healthy).toBe(false);
      expect(inspected.reason).toBe("stale_pid");
    }
  });

  it("removeDaemonLock respects expected pid", async () => {
    const home = await tempHome();
    const { path: tokenPath } = await writeDaemonToken(home);
    await writeDaemonLock(
      buildLock({ port: 7420, tokenPath, pid: process.pid }),
      home,
    );
    expect(await removeDaemonLock(home, { expectedPid: process.pid + 999 })).toBe(
      false,
    );
    expect(await removeDaemonLock(home, { expectedPid: process.pid })).toBe(true);
    expect(await readDaemonLock(home)).toBeNull();
  });

  it("exclusive lock create is single-winner", async () => {
    const home = await tempHome();
    const lock = buildLock({
      port: 7420,
      tokenPath: daemonTokenPath(home),
      pid: process.pid,
    });
    expect(await tryCreateDaemonLockExclusive(lock, home)).toBe(true);
    expect(await tryCreateDaemonLockExclusive(lock, home)).toBe(false);

    await removeDaemonLock(home, { force: true });
    // stale foreign pid → acquire clears and succeeds
    await writeDaemonLock(
      buildLock({
        port: 7420,
        tokenPath: daemonTokenPath(home),
        pid: 2_147_483_646,
      }),
      home,
    );
    if (!isPidAlive(2_147_483_646)) {
      await acquireDaemonLockExclusive(lock, home);
      const read = await readDaemonLock(home);
      expect(read?.pid).toBe(process.pid);
    }
  });

  it("token file is written and readable by owner", async () => {
    const home = await tempHome();
    const { path } = await writeDaemonToken(home, "abc");
    await access(path, fsConstants.R_OK);
    expect(await readDaemonToken(home)).toBe("abc");
  });
});
