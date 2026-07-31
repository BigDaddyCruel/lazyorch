/**
 * `lazyorch gate list|approve|reject` — operator gate UX (local StateStore).
 *
 * Type-specific apply helpers used when available; otherwise generic resolveGate.
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
   * Extra action for typed gates:
   * - plan_approve reject: cancel | revise (default cancel)
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
          // Persist run when phase/reasons changed
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
        // Plan FSM precondition failures → exit 5
        if (
          /requires PlanConsensus|requires Planning|requires MergeReady|plan_/.test(
            msg,
          )
        ) {
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
      const action: PlanRejectAction =
        decisionDetail === "revise" ? "revise" : "cancel";
      const r = applyPlanApproveDecision(run, gate, "reject", {
        ...base,
        plan_reject_action: action,
      });
      return { gate: r.gate, run: r.run };
    }
    case "plan_dispute": {
      let resolution: PlanDisputeResolution;
      if (decision === "reject" || decisionDetail === "abort") {
        resolution = "abort";
      } else if (decisionDetail === "force_addressed") {
        resolution = "force_addressed";
      } else {
        resolution = "accept_wontfix";
      }
      const r = applyPlanDisputeDecision(run, gate, resolution, base);
      return { gate: r.gate, run: r.run, note: `resolution=${resolution}` };
    }
    case "plan_max_rounds": {
      let action: PlanMaxRoundsAction;
      if (decision === "reject" || decisionDetail === "abort") {
        action = "abort";
      } else if (decisionDetail === "edit") {
        action = "edit";
      } else {
        action = "force_approve";
      }
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
      // human_intervention, budget_override, task_approve, destructive_git, …
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
