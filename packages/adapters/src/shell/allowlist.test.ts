import { describe, expect, it } from "vitest";
import {
  checkShellAllowlist,
  commandNameFromArgv,
  DEFAULT_SHELL_ALLOWLIST,
} from "./allowlist.js";

describe("commandNameFromArgv", () => {
  it("extracts basename without extension", () => {
    expect(commandNameFromArgv(["node", "-e", "1"])).toBe("node");
    expect(commandNameFromArgv(["C:\\\\Tools\\\\node.exe", "a"])).toBe("node");
    expect(commandNameFromArgv(["/usr/bin/pnpm", "test"])).toBe("pnpm");
  });

  it("returns null for empty", () => {
    expect(commandNameFromArgv([])).toBeNull();
    expect(commandNameFromArgv(["  "])).toBeNull();
  });
});

describe("checkShellAllowlist", () => {
  it("allows default commands", () => {
    for (const cmd of DEFAULT_SHELL_ALLOWLIST.allowed_commands) {
      const r = checkShellAllowlist([cmd, "--version"], DEFAULT_SHELL_ALLOWLIST);
      expect(r.ok).toBe(true);
    }
  });

  it("rejects unknown commands", () => {
    const r = checkShellAllowlist(["rm", "-rf", "/tmp/x"], DEFAULT_SHELL_ALLOWLIST);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/allowlist/);
  });

  it("rejects deny_patterns even when binary is allowed", () => {
    const r = checkShellAllowlist(
      ["git", "push", "--force", "origin", "main"],
      DEFAULT_SHELL_ALLOWLIST,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/deny_pattern/);
  });

  it("rejects empty argv", () => {
    const r = checkShellAllowlist([], DEFAULT_SHELL_ALLOWLIST);
    expect(r.ok).toBe(false);
  });

  it("matches deny_patterns case-insensitively", () => {
    const r = checkShellAllowlist(
      ["git", "push", "-f", "origin", "x"],
      DEFAULT_SHELL_ALLOWLIST,
    );
    expect(r.ok).toBe(false);
  });
});
