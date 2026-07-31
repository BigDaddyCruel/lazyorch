/**
 * Shell adapter allowlist + deny_patterns (design-lazyorch KD-23).
 * Deterministic sessions only: command argv must pass before spawn.
 */

import { basename } from "node:path";

export interface ShellAllowlistConfig {
  allowed_commands: readonly string[];
  deny_patterns: readonly string[];
}

export type AllowlistResult =
  | { ok: true; command_name: string }
  | { ok: false; reason: string };

/**
 * Extract the command name used for allowlist matching.
 * Uses basename so `C:\tools\node.exe` and `/usr/bin/node` both match `node`.
 */
export function commandNameFromArgv(argv: readonly string[]): string | null {
  const first = argv[0];
  if (first === undefined || first.trim() === "") return null;
  // Strip Windows extension for comparison (node.exe → node)
  const base = basename(first).toLowerCase();
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, "");
}

/**
 * Check argv against allowed_commands and deny_patterns.
 * - First token basename must be in allowed_commands (case-insensitive).
 * - Joined argv must not match any deny_pattern regex.
 */
export function checkShellAllowlist(
  argv: readonly string[],
  config: ShellAllowlistConfig,
): AllowlistResult {
  if (argv.length === 0) {
    return { ok: false, reason: "empty command argv" };
  }

  const name = commandNameFromArgv(argv);
  if (name === null) {
    return { ok: false, reason: "missing command name" };
  }

  const allowed = new Set(
    config.allowed_commands.map((c) => c.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/i, "")),
  );
  if (!allowed.has(name)) {
    return {
      ok: false,
      reason: `command "${name}" is not on the shell allowlist`,
    };
  }

  const joined = argv.join(" ");
  for (const pattern of config.deny_patterns) {
    let re: RegExp;
    try {
      re = new RegExp(pattern, "i");
    } catch {
      // Invalid regex in config: treat as literal substring match
      if (joined.toLowerCase().includes(pattern.toLowerCase())) {
        return {
          ok: false,
          reason: `command matches deny_pattern: ${pattern}`,
        };
      }
      continue;
    }
    if (re.test(joined)) {
      return {
        ok: false,
        reason: `command matches deny_pattern: ${pattern}`,
      };
    }
  }

  return { ok: true, command_name: name };
}

/** Design-doc default allowlist (also in shared ShellConfigSchema). */
export const DEFAULT_SHELL_ALLOWLIST: ShellAllowlistConfig = {
  allowed_commands: [
    "git",
    "npm",
    "pnpm",
    "node",
    "npx",
    "vitest",
    "tsc",
    "eslint",
  ],
  deny_patterns: ["rm -rf /", "git push --force", "git push -f"],
};
