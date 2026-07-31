/**
 * Parse SessionResult structured markers from result.json / stdout.
 * Sources checked in order (design):
 * 1. session_dir/result.json if present and valid JSON
 * 2. Last non-empty stdout line if it parses as JSON with expected keys
 * 3. Else role-specific fallbacks (caller)
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  QaDecision,
  ReviewDecision,
  StructuredDecision,
  WorkerMarker,
} from "../types.js";

export function resultJsonPath(sessionDir: string): string {
  return join(sessionDir, "result.json");
}

export async function readResultJsonFile(
  sessionDir: string,
): Promise<unknown | null> {
  try {
    const raw = await readFile(resultJsonPath(sessionDir), "utf8");
    return JSON.parse(raw) as unknown;
  } catch (err) {
    if (isNotFound(err)) return null;
    // invalid JSON → treat as missing
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

export function parseStructuredDecision(
  value: unknown,
): StructuredDecision | null {
  if (value === null || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;

  // Explicit kind
  if (obj.kind === "worker" && typeof obj.submitted === "boolean") {
    const m: WorkerMarker = {
      kind: "worker",
      submitted: obj.submitted,
    };
    if (typeof obj.notes === "string") m.notes = obj.notes;
    return m;
  }
  if (
    obj.kind === "review" &&
    (obj.decision === "approve" || obj.decision === "reject")
  ) {
    const m: ReviewDecision = {
      kind: "review",
      decision: obj.decision,
    };
    if (typeof obj.comments === "string") m.comments = obj.comments;
    return m;
  }
  if (obj.kind === "qa" && typeof obj.passed === "boolean") {
    const m: QaDecision = {
      kind: "qa",
      passed: obj.passed,
    };
    if (typeof obj.summary === "string") m.summary = obj.summary;
    return m;
  }

  // Implicit shapes without kind
  if (typeof obj.submitted === "boolean") {
    const m: WorkerMarker = {
      kind: "worker",
      submitted: obj.submitted,
    };
    if (typeof obj.notes === "string") m.notes = obj.notes;
    return m;
  }
  if (obj.decision === "approve" || obj.decision === "reject") {
    const m: ReviewDecision = {
      kind: "review",
      decision: obj.decision,
    };
    if (typeof obj.comments === "string") m.comments = obj.comments;
    return m;
  }
  if (typeof obj.passed === "boolean") {
    const m: QaDecision = {
      kind: "qa",
      passed: obj.passed,
    };
    if (typeof obj.summary === "string") m.summary = obj.summary;
    return m;
  }

  return null;
}

/** Last non-empty line of stdout that parses as structured decision JSON. */
export function parseLastStdoutJsonLine(
  stdout: string,
): StructuredDecision | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    try {
      const parsed = JSON.parse(line) as unknown;
      const decision = parseStructuredDecision(parsed);
      if (decision) return decision;
    } catch {
      // not JSON
    }
  }
  return null;
}

export async function resolveStructuredDecision(
  sessionDir: string,
  stdout?: string,
): Promise<{
  decision: StructuredDecision | null;
  raw_result_path?: string;
}> {
  const fromFile = await readResultJsonFile(sessionDir);
  if (fromFile !== null) {
    const decision = parseStructuredDecision(fromFile);
    if (decision) {
      return { decision, raw_result_path: resultJsonPath(sessionDir) };
    }
  }
  if (stdout !== undefined && stdout.length > 0) {
    const decision = parseLastStdoutJsonLine(stdout);
    if (decision) return { decision };
  }
  return { decision: null };
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}
