/**
 * `lazyorch context` — shared run context KV (local StateStore stub).
 *
 * Operates on `<repo>/.lazyorch/runs/<run_id>/context.json`.
 * Human operator writes are always allowed (daemon/session ACL applies on HTTP).
 */
import { resolve } from "node:path";
import {
  ContextKvError,
  StateStore,
  assertValidContextKey,
  getContextValue,
  listContextKeys,
  type RunContext,
} from "@lazyorch/core";

export type ContextSubcommand = "list" | "get" | "set" | "delete";

export interface ContextOptions {
  /** Subcommand */
  action: ContextSubcommand;
  /** Run id (required). */
  run: string;
  /** Key for get/set/delete. */
  key?: string;
  /** Raw value string for set (JSON if parseable, else string). */
  value?: string;
  /** Repository root (default cwd). */
  repo?: string;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  /** Pretty-print JSON (default true). */
  pretty?: boolean;
}

export interface ContextResult {
  exitCode: number;
  action: ContextSubcommand;
  runId: string;
  context?: RunContext;
  key?: string;
  value?: unknown;
  deleted?: boolean;
  message?: string;
}

function stateRoot(repo: string): string {
  return resolve(repo, ".lazyorch");
}

function parseSetValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return raw;
  }
}

function writeJson(
  stdout: NodeJS.WritableStream,
  value: unknown,
  pretty: boolean,
): void {
  const text = pretty
    ? `${JSON.stringify(value, null, 2)}\n`
    : `${JSON.stringify(value)}\n`;
  stdout.write(text);
}

/**
 * Run `lazyorch context list|get|set|delete`.
 */
export async function runContext(options: ContextOptions): Promise<ContextResult> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const pretty = options.pretty !== false;
  const repo = resolve(options.repo ?? process.cwd());
  const runId = options.run?.trim() ?? "";

  if (!runId) {
    stderr.write("error: --run <id> is required\n");
    return { exitCode: 2, action: options.action, runId: "", message: "missing run" };
  }

  const store = new StateStore(stateRoot(repo));
  const run = await store.readRun(runId);
  if (!run) {
    stderr.write(
      `error: run not found: ${runId} (looked under ${stateRoot(repo)})\n`,
    );
    return {
      exitCode: 1,
      action: options.action,
      runId,
      message: "run_not_found",
    };
  }

  try {
    switch (options.action) {
      case "list": {
        const ctx = await store.loadOrEmptyContext(runId);
        const keys = listContextKeys(ctx);
        const payload = {
          run_id: runId,
          updated_at: ctx.updated_at,
          keys,
          kv: Object.fromEntries(keys.map((k) => [k, ctx.kv[k]])),
        };
        writeJson(stdout, payload, pretty);
        return { exitCode: 0, action: "list", runId, context: ctx };
      }
      case "get": {
        const key = options.key?.trim() ?? "";
        if (!key) {
          stderr.write("error: context get requires <key>\n");
          return { exitCode: 2, action: "get", runId, message: "missing key" };
        }
        assertValidContextKey(key);
        const ctx = await store.loadOrEmptyContext(runId);
        if (!Object.prototype.hasOwnProperty.call(ctx.kv, key)) {
          stderr.write(`error: context key not found: ${key}\n`);
          return {
            exitCode: 1,
            action: "get",
            runId,
            key,
            message: "not_found",
          };
        }
        const value = getContextValue(ctx, key);
        writeJson(stdout, { run_id: runId, key, value }, pretty);
        return { exitCode: 0, action: "get", runId, key, value, context: ctx };
      }
      case "set": {
        const key = options.key?.trim() ?? "";
        if (!key) {
          stderr.write("error: context set requires <key> <value>\n");
          return { exitCode: 2, action: "set", runId, message: "missing key" };
        }
        if (options.value === undefined) {
          stderr.write("error: context set requires <key> <value>\n");
          return { exitCode: 2, action: "set", runId, key, message: "missing value" };
        }
        assertValidContextKey(key);
        const value = parseSetValue(options.value);
        const ctx = await store.setContextKey(runId, key, value);
        writeJson(
          stdout,
          { run_id: runId, key, value: ctx.kv[key], updated_at: ctx.updated_at },
          pretty,
        );
        return { exitCode: 0, action: "set", runId, key, value: ctx.kv[key], context: ctx };
      }
      case "delete": {
        const key = options.key?.trim() ?? "";
        if (!key) {
          stderr.write("error: context delete requires <key>\n");
          return { exitCode: 2, action: "delete", runId, message: "missing key" };
        }
        assertValidContextKey(key);
        const deleted = await store.deleteContextKey(runId, key);
        if (!deleted) {
          stderr.write(`error: context key not found: ${key}\n`);
          return {
            exitCode: 1,
            action: "delete",
            runId,
            key,
            deleted: false,
            message: "not_found",
          };
        }
        writeJson(stdout, { ok: true, run_id: runId, key, deleted: true }, pretty);
        return { exitCode: 0, action: "delete", runId, key, deleted: true };
      }
      default: {
        stderr.write(`error: unknown context action\n`);
        return { exitCode: 2, action: options.action, runId, message: "usage" };
      }
    }
  } catch (err) {
    if (err instanceof ContextKvError) {
      stderr.write(`error: ${err.message}\n`);
      const code =
        err.code === "forbidden" ? 1 : err.code === "not_found" ? 1 : 2;
      return {
        exitCode: code,
        action: options.action,
        runId,
        message: err.code,
      };
    }
    throw err;
  }
}
