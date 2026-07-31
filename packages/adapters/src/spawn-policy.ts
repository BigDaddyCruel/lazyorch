/**
 * Shared spawn argv policy for Windows shell scripts (.cmd/.bat/.ps1).
 * Node cannot spawn those with shell:false (EINVAL); use ComSpec /c.
 */

export function isWindowsShellScript(
  file: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "win32") return false;
  return /\.(cmd|bat|ps1)$/i.test(file);
}

/** Quote a single Windows cmdline argument (CreateProcess-safe). */
export function quoteWindowsArg(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[\s"]/u.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

export interface ResolvedSpawnTarget {
  /** Executable to pass as spawn file. */
  file: string;
  /** Args after file. */
  args: string[];
  /**
   * When true, caller may set shell:true as a fallback.
   * Preferred path rewrites to cmd.exe so shell stays false.
   */
  via_comspec: boolean;
}

/**
 * Rewrite argv for spawn so Windows .cmd/.bat/.ps1 run under cmd.exe.
 * POSIX / PE binaries are unchanged.
 */
export function resolveSpawnTarget(
  file: string,
  args: readonly string[],
  options: {
    platform?: NodeJS.Platform;
    comspec?: string;
  } = {},
): ResolvedSpawnTarget {
  const platform = options.platform ?? process.platform;
  if (!isWindowsShellScript(file, platform)) {
    return { file, args: [...args], via_comspec: false };
  }

  const comspec = options.comspec ?? process.env.ComSpec ?? "cmd.exe";
  // /d disables AutoRun; /s /c preserves the quoted command string.
  const cmdline = [quoteWindowsArg(file), ...args.map(quoteWindowsArg)].join(
    " ",
  );
  return {
    file: comspec,
    args: ["/d", "/s", "/c", cmdline],
    via_comspec: true,
  };
}
