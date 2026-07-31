/**
 * `lazyorch serve` — ensure user-level daemon is running (ensureDaemon).
 *
 * Foreground: inline startDaemon (keeps process alive via returned serve).
 * --background: spawn mode.
 */
import {
  ensureDaemon,
  type DaemonEndpoint,
  type EnsureDaemonOptions,
} from "@lazyorch/daemon";
import { EXIT } from "../exit-codes.js";
import { writeJson, writeLine } from "../util.js";

export interface ServeCommandOptions {
  port?: number;
  host?: string;
  home?: string;
  background?: boolean;
  /** When true, exit after ensure (do not keep alive). Default for --background. */
  once?: boolean;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  pretty?: boolean;
  /** Inject ensureDaemon for tests. */
  ensure?: (opts: EnsureDaemonOptions) => Promise<DaemonEndpoint>;
  /**
   * Keepalive hook for foreground mode (default: never-resolving promise).
   * Tests inject a resolving promise so the command can finish.
   */
  keepAlive?: () => Promise<void>;
}

export interface ServeCommandResult {
  exitCode: number;
  endpoint?: DaemonEndpoint;
  message?: string;
}

/**
 * Ensure daemon and optionally keep process alive.
 */
export async function runServe(
  options: ServeCommandOptions = {},
): Promise<ServeCommandResult> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const pretty = options.pretty !== false;
  const background = options.background === true;
  const once = options.once === true || background;

  const ensure = options.ensure ?? ensureDaemon;
  const ensureOpts: EnsureDaemonOptions = {
    mode: background ? "spawn" : "inline",
  };
  if (options.home !== undefined) ensureOpts.homeDir = options.home;
  if (options.host !== undefined) ensureOpts.host = options.host;
  if (options.port !== undefined) ensureOpts.port = options.port;

  try {
    const ep = await ensure(ensureOpts);
    writeJson(
      stdout,
      {
        ok: true,
        url: ep.url,
        host: ep.host,
        port: ep.port,
        pid: ep.pid ?? null,
        started: ep.started,
        background,
      },
      pretty,
    );

    if (!once) {
      writeLine(
        stderr,
        `lazyorch daemon listening on ${ep.url} (Ctrl+C to stop when owning process)`,
      );
      const keep =
        options.keepAlive ??
        (() =>
          new Promise<void>(() => {
            /* never resolves */
          }));
      await keep();
    }

    return { exitCode: EXIT.OK, endpoint: ep };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(`error: ${msg}\n`);
    return { exitCode: EXIT.ERROR, message: msg };
  }
}
