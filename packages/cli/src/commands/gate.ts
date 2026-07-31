/**
 * `lazyorch gate list|approve|reject` — operator gate UX (local StateStore).
 *
 * Multi-outcome gates require explicit `--decision` (no silent force_approve).
 * Exit 3 from list when --check and pending gates exist.
 */
import { resolve } from "node:path";
import {
  applyMergeGateDecision,
  applyPlanApproveDecision,
  applyPlanDisputeDecision,
  applyPlanMaxRoundsDecision,
  resolveGate,
  type Gate,
  type PlanDisputeResolution,
  type PlanMaxRoundsAction,
  type PlanRejectAction,
  type Run,
} from "@lazyorch/core";
import { EXIT } from "../exit-codes.js";
import {
  createStore,
  findGate,
  listAllGates,
  writeJson,
} from "../util.js";

export type GateSubcommand = "list" | "approve" | "reject";

export interface GateCommandOptions {
  action: GateSubcommand;
  /** Gate id for approve/reject. */
  gateId?: string;
  /** Optional run scope for list / lookup. */
  run?: string;
  /** Filter list by status (default pending for list). */
  status?: string;
  /** When true, list exits 3 if any pending. */
  check?: boolean;
  /** Show all statuses (not just pending). */
  all?: boolean;
  /**
   * Extra action for multi-outcome gates (required where applicable):
   * - plan_approve reject: cancel | revise
   * - plan_dispute: accept_wontfix | force_addressed | abort
   * - plan_max_rounds: force_approve | edit | abort
   */
  decision?: string;
  /** Who resolved (default "cli"). */
  resolvedBy?: string;
  repo?: string;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  pretty?: boolean;
  now?: () => string;
}

export interface GateCommandResult {
  exitCode: number;
  action: GateSubcommand;
  gates?: Gate[];
  gate?: Gate;
  run?: Run;
  message?: string;
}

const PLAN_REJECT_ACTIONS = new Set<string>(["cancel", "revise"]);
const PLAN_DISPUTE_RESOLUTIONS = new Set<string>([
  "accept_wontfix",
  "force_addressed",
  "abort",
]);
const PLAN_MAX_ROUNDS_ACTIONS = new Set<string>([
  "force_approve",
  "edit",
  "abort",
]);

/** Allowed --decision values by gate type + approve|reject. */
export function allowedDecisions(
  gateType: string,
  action: "approve" | "reject",
): string[] | null {
  switch (gateType) {
    case "plan_approve":
      return action === "reject" ? ["cancel", "revise"] : null;
    case "plan_dispute":
      return ["accept_wontfix", "force_addressed", "abort"];
    case "plan_max_rounds":
      return ["force_approve", "edit", "abort"];
    default:
      return null;
  }
}

export async function runGate(
  options: GateCommandOptions,
): Promise<GateCommandResult> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const pretty = options.pretty !== false;
  const repo = resolve(options.repo ?? process.cwd());
  const store = createStore(repo);

  switch (options.action) {
    case "list": {
      const statusFilter =
        options.all === true
          ? undefined
          : (options.status ?? "pending");
      const gates = await listAllGates(store, {
        ...(statusFilter ? { status: statusFilter } : {}),
        ...(options.run ? { runId: options.run } : {}),
      });
      writeJson(
        stdout,
        {
          count: gates.length,
          status_filter: statusFilter ?? "all",
          gates: gates.map((g) => ({
            id: g.id,
            type: g.type,
            run_id: g.run_id,
            status: g.status,
            created_at: g.created_at,
            timeout_at: g.timeout_at ?? null,
            payload: g.payload,
            resolved_at: g.resolved_at ?? null,
            resolved_by: g.resolved_by ?? null,
          })),
        },
        pretty,
      );

      if (options.check === true) {
        const pending =
          statusFilter === "pending"
            ? gates
            : gates.filter((g) => g.status === "pending");
        if (pending.length > 0) {
          return {
            exitCode: EXIT.GATE,
            action: "list",
            gates,
            message: "gate_pending",
          };
        }
      }
      return { exitCode: EXIT.OK, action: "list", gates };
    }

    case "approve":
    case "reject": {
      const gateId = options.gateId?.trim() ?? "";
      if (!gateId) {
        stderr.write(`error: gate ${options.action} requires <gate_id>\n`);
        return {
          exitCode: EXIT.USAGE,
          action: options.action,
          message: "missing gate id",
        };
      }

      const found = await findGate(store, gateId, options.run);
      if (!found) {
        stderr.write(`error: gate not found: ${gateId}\n`);
        return {
          exitCode: EXIT.ERROR,
          action: options.action,
          message: "not_found",
        };
      }

      if (found.gate.status !== "pending") {
        stderr.write(
          `error: gate ${gateId} is ${found.gate.status}, expected pending\n`,
        );
        return {
          exitCode: EXIT.ERROR,
          action: options.action,
          gate: found.gate,
          run: found.run,
          message: "not_pending",
        };
      }

      // Validate multi-outcome --decision before applying.
      const decisionCheck = validateDecision(
        found.gate.type,
        options.action,
        options.decision,
      );
      if (!decisionCheck.ok) {
        stderr.write(`error: ${decisionCheck.message}\n`);
        return {
          exitCode: EXIT.USAGE,
          action: options.action,
          gate: found.gate,
          run: found.run,
          message: decisionCheck.message,
        };
      }

      try {
        const decision = options.action === "approve" ? "approve" : "reject";
        const applied = applyGateDecision({
          run: found.run,
          gate: found.gate,
          decision,
          resolvedBy: options.resolvedBy ?? "cli",
          ...(options.decision !== undefined
            ? { decisionDetail: options.decision }
            : {}),
          ...(options.now !== undefined ? { now: options.now } : {}),
        });

        const nextGates = found.gates.map((g) =>
          g.id === applied.gate.id ? applied.gate : g,
        );
        await store.writeGates(found.run.id, nextGates);
        if (applied.run.id === found.run.id) {
          const prev = found.run;
          const next = applied.run;
          if (
            prev.phase !== next.phase ||
            prev.updated_at !== next.updated_at ||
            prev.cancelled_reason !== next.cancelled_reason ||
            prev.failed_reason !== next.failed_reason
          ) {
            await store.writeRun(next);
          }
        }

        writeJson(
          stdout,
          {
            ok: true,
            action: options.action,
            gate: applied.gate,
            run: {
              id: applied.run.id,
              phase: applied.run.phase,
              cancelled_reason: applied.run.cancelled_reason ?? null,
              failed_reason: applied.run.failed_reason ?? null,
            },
            should_merge: applied.should_merge ?? false,
            note: applied.note ?? null,
          },
          pretty,
        );

        return {
          exitCode: EXIT.OK,
          action: options.action,
          gate: applied.gate,
          run: applied.run,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        stderr.write(`error: ${msg}\n`);
        if (isPlanFsmError(msg)) {
          return {
            exitCode: EXIT.PLAN,
            action: options.action,
            gate: found.gate,
            run: found.run,
            message: msg,
          };
        }
        return {
          exitCode: EXIT.ERROR,
          action: options.action,
          gate: found.gate,
          run: found.run,
          message: msg,
        };
      }
    }

    default: {
      stderr.write("error: gate requires list|approve|reject\n");
      return { exitCode: EXIT.USAGE, action: options.action, message: "usage" };
    }
  }
}

/** Core FSM precondition failures → exit 5 (tight prefixes, not bare plan_). */
function isPlanFsmError(msg: string): boolean {
  return (
    msg.startsWith("applyPlanApproveDecision") ||
    msg.startsWith("applyPlanDisputeDecision") ||
    msg.startsWith("applyPlanMaxRoundsDecision") ||
    msg.startsWith("applyMergeGateDecision") ||
    /requires PlanConsensus/.test(msg) ||
    /requires Planning/.test(msg) ||
    /requires MergeReady/.test(msg) ||
    /plan_approve (approve|revise|cancel) requires/.test(msg)
  );
}

function validateDecision(
  gateType: string,
  action: "approve" | "reject",
  decision: string | undefined,
): { ok: true } | { ok: false; message: string } {
  const allowed = allowedDecisions(gateType, action);
  if (allowed === null) {
    // Binary approve/reject only — --decision optional; if present, warn? reject invalid
    if (decision !== undefined && decision.trim() !== "") {
      // Generic gates ignore decision; allow extra payload only — ok
      return { ok: true };
    }
    return { ok: true };
  }

  // Multi-outcome: require explicit --decision
  if (decision === undefined || decision.trim() === "") {
    return {
      ok: false,
      message: `${gateType} requires --decision ${allowed.join("|")}`,
    };
  }
  const d = decision.trim();
  if (!allowed.includes(d)) {
    return {
      ok: false,
      message: `invalid --decision '${d}' for ${gateType}; allowed: ${allowed.join("|")}`,
    };
  }

  // plan_approve: approve path forbids --decision (binary)
  if (gateType === "plan_approve" && action === "approve") {
    // allowed is null for approve — handled above
  }

  // plan_dispute / plan_max_rounds: reject maps to abort only when decision is abort
  // (operator must say --decision abort explicitly; already required)
  void PLAN_REJECT_ACTIONS;
  void PLAN_DISPUTE_RESOLUTIONS;
  void PLAN_MAX_ROUNDS_ACTIONS;

  return { ok: true };
}

interface ApplyResult {
  gate: Gate;
  run: Run;
  should_merge?: boolean;
  note?: string;
}

function applyGateDecision(opts: {
  run: Run;
  gate: Gate;
  decision: "approve" | "reject";
  decisionDetail?: string;
  resolvedBy: string;
  now?: () => string;
}): ApplyResult {
  const { run, gate, decision, decisionDetail, resolvedBy, now } = opts;
  const base = { resolved_by: resolvedBy, ...(now ? { now } : {}) };

  switch (gate.type) {
    case "plan_approve": {
      if (decision === "approve") {
        const r = applyPlanApproveDecision(run, gate, "approve", base);
        return { gate: r.gate, run: r.run };
      }
      // decisionDetail validated as cancel|revise
      const action: PlanRejectAction =
        decisionDetail === "revise" ? "revise" : "cancel";
      const r = applyPlanApproveDecision(run, gate, "reject", {
        ...base,
        plan_reject_action: action,
      });
      return { gate: r.gate, run: r.run, note: `reject_action=${action}` };
    }
    case "plan_dispute": {
      // Required + validated
      const resolution = decisionDetail as PlanDisputeResolution;
      const r = applyPlanDisputeDecision(run, gate, resolution, base);
      return { gate: r.gate, run: r.run, note: `resolution=${resolution}` };
    }
    case "plan_max_rounds": {
      const action = decisionDetail as PlanMaxRoundsAction;
      const r = applyPlanMaxRoundsDecision(run, gate, action, base);
      return { gate: r.gate, run: r.run, note: `action=${action}` };
    }
    case "merge": {
      const r = applyMergeGateDecision(run, gate, decision, base);
      const out: ApplyResult = {
        gate: r.gate,
        run: r.run,
        should_merge: r.should_merge,
      };
      if (r.should_merge) {
        out.note = "merge approved; forge merge is caller's job";
      }
      return out;
    }
    default: {
      const status = decision === "approve" ? "approved" : "rejected";
      const nextGate = resolveGate(gate, status, {
        ...base,
        require_pending: true,
        ...(decisionDetail
          ? { payload: { decision_detail: decisionDetail } }
          : {}),
      });
      return {
        gate: nextGate,
        run,
        note: `generic resolve (${gate.type})`,
      };
    }
  }
}
