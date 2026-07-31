/**
 * runs/<run_id>/sessions.json — pid table for orphan reaping and slot accounting.
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { SessionRecord, SessionsFile } from "../types.js";

export function sessionsFilePath(runDir: string): string {
  return join(runDir, "sessions.json");
}

export function runSessionsDir(runDir: string): string {
  return join(runDir, "sessions");
}

export function sessionDirFor(runDir: string, runHandle: string): string {
  return join(runSessionsDir(runDir), runHandle);
}

export function emptySessionsFile(): SessionsFile {
  return { schema_version: 1, sessions: {} };
}

export async function readSessionsFile(
  path: string,
): Promise<SessionsFile> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as SessionsFile;
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.schema_version === 1 &&
      parsed.sessions &&
      typeof parsed.sessions === "object"
    ) {
      return parsed;
    }
    return emptySessionsFile();
  } catch (err) {
    if (isNotFound(err)) return emptySessionsFile();
    throw err;
  }
}

export async function writeSessionsFile(
  path: string,
  file: SessionsFile,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const body = `${JSON.stringify(file, null, 2)}\n`;
  const tmp = join(dirname(path), `.${randomBytes(8).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, body, "utf8");
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/** Register a running session. Overwrites any prior entry with the same handle. */
export async function registerSession(
  sessionsPath: string,
  record: SessionRecord,
): Promise<void> {
  const file = await readSessionsFile(sessionsPath);
  file.sessions[record.run_handle] = record;
  await writeSessionsFile(sessionsPath, file);
}

/** Update status / ended_at for a session. No-op if missing. */
export async function updateSessionRecord(
  sessionsPath: string,
  runHandle: string,
  patch: Partial<Pick<SessionRecord, "status" | "ended_at" | "pid">>,
): Promise<void> {
  const file = await readSessionsFile(sessionsPath);
  const existing = file.sessions[runHandle];
  if (!existing) return;
  file.sessions[runHandle] = { ...existing, ...patch };
  await writeSessionsFile(sessionsPath, file);
}

/** Remove a session entry after reaping / cleanup. */
export async function clearSession(
  sessionsPath: string,
  runHandle: string,
): Promise<void> {
  const file = await readSessionsFile(sessionsPath);
  if (!(runHandle in file.sessions)) return;
  delete file.sessions[runHandle];
  await writeSessionsFile(sessionsPath, file);
}

/** Count currently running sessions (slots_used). */
export function countRunningSessions(file: SessionsFile): number {
  let n = 0;
  for (const rec of Object.values(file.sessions)) {
    if (rec.status === "running") n += 1;
  }
  return n;
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}
