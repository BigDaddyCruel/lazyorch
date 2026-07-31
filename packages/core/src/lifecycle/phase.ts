/**
 * Post-Implementing lifecycle tick: PrePR → PROpen → CILoop → MergeReady → Merged.
 *
 * Call after implementingTick sets phase to PrePR or CILoop.
 * Merge gate human path: open gate; on approve call forge.mergePr → Merged.
 */

import type { Gate } from "../types/gate.js";
import type { Run } from "../types/run.js";
import type { Task } from "../types/task.js";
import { runCiLoopTick, type CiLoopConfig } from "./ciloop.js";
import {
  applyMerged,
  createMergeGate,
  hasPendingMergeGate,
  shouldAutoMerge,
} from "./merge-gate.js";
import type { ForgeGithubPort, MergeMethod } from "./ports.js";
import {
  runPrePrPhase,
  runPrOpenPhase,
  type PrePrConfig,
} from "./prepr.js";

export interface LifecycleTickParams {
  run: Run;
  tasks: readonly Task[];
  forge: ForgeGithubPort;
  prepr?: PrePrConfig;
  ciloop?: CiLoopConfig;
  /** Existing gates (merge gate idempotency). */
  existing_gates?: readonly Gate[];
  /**
   * merge_gate config: human (default) | auto.
   * Combined with gates_merge.
   */
  merge_gate?: "human" | "auto";
  /** gates.merge — when false, auto-merge allowed. Default true. */
  gates_merge?: boolean;
  merge_method?: MergeMethod;
  /**
   * When set and phase is MergeReady, treat as approved merge gate
   * (operator already resolved). Triggers forge merge.
   */
  merge_approved?: boolean;
  now?: () => string;
  nextGateId?: () => string;
  nextTaskId?: () => string;
}

export interface LifecycleTickResult {
  run: Run;
  tasks: Task[];
  gates: Gate[];
  transitions: Array<{ from: string; to: string; noop?: boolean }>;
  poll_pending: boolean;
  merged: boolean;
  fix_task_ids: string[];
}

/**
 * Advance one step of post-Implementing lifecycle for the current phase.
 */
export async function lifecycleTick(
  params: LifecycleTickParams,
): Promise<LifecycleTickResult> {
  const gates: Gate[] = [];
  const transitions: LifecycleTickResult["transitions"] = [];
  const fix_task_ids: string[] = [];
  let run = params.run;
  let tasks = [...params.tasks];
  let poll_pending = false;
  let merged = false;
  const existing = [...(params.existing_gates ?? [])];

  if (run.phase === "PrePR") {
    const r = await runPrePrPhase(run, params.forge, params.prepr ?? {}, {
      ...(params.now !== undefined ? { now: params.now } : {}),
    });
    run = r.run;
    transitions.push(...r.transitions);
    // Instant PROpen → CILoop in same tick when we landed on PROpen
    if (run.phase === "PROpen") {
      const open = runPrOpenPhase(run, {
        ...(params.now !== undefined ? { now: params.now } : {}),
      });
      run = open.run;
      transitions.push(...open.transitions);
    }
  } else if (run.phase === "PROpen") {
    const open = runPrOpenPhase(run, {
      ...(params.now !== undefined ? { now: params.now } : {}),
    });
    run = open.run;
    transitions.push(...open.transitions);
  } else if (run.phase === "CILoop") {
    const r = await runCiLoopTick(
      run,
      tasks,
      params.forge,
      params.ciloop ?? {},
      {
        ...(params.now !== undefined ? { now: params.now } : {}),
        ...(params.nextTaskId !== undefined
          ? { nextTaskId: params.nextTaskId }
          : {}),
      },
    );
    run = r.run;
    tasks = r.tasks;
    transitions.push(...r.transitions);
    for (const t of r.fix_tasks) fix_task_ids.push(t.id);
    poll_pending = r.poll?.pending === true;
  } else if (run.phase === "MergeReady") {
    const auto = shouldAutoMerge({
      merge_gate: params.merge_gate ?? "human",
      gates_merge: params.gates_merge ?? true,
    });
    const prNumber = run.pr_ref?.number;
    const wantMerge = auto || params.merge_approved === true;

    if (!wantMerge) {
      if (
        prNumber !== undefined &&
        !hasPendingMergeGate(existing, run.id, prNumber)
      ) {
        const g = createMergeGate({
          run_id: run.id,
          pr_number: prNumber,
          ...(run.pr_ref?.url !== undefined ? { pr_url: run.pr_ref.url } : {}),
          ...(run.pr_ref?.head_sha !== undefined
            ? { head_sha: run.pr_ref.head_sha }
            : {}),
          ...(params.now !== undefined ? { now: params.now } : {}),
          ...(params.nextGateId !== undefined
            ? { nextId: params.nextGateId }
            : {}),
        });
        gates.push(g);
      }
    } else if (prNumber !== undefined) {
      const result = await params.forge.mergePr({
        run_id: run.id,
        pr_number: prNumber,
        method: params.merge_method ?? "squash",
        ...(params.prepr?.owner !== undefined
          ? { owner: params.prepr.owner }
          : {}),
        ...(params.prepr?.repo !== undefined
          ? { repo: params.prepr.repo }
          : {}),
      });
      if (result.merged) {
        run = applyMerged(run, {
          ...(result.sha !== undefined ? { sha: result.sha } : {}),
          ...(params.now !== undefined ? { now: params.now } : {}),
        });
        transitions.push({ from: "MergeReady", to: "Merged" });
        merged = true;
      }
    }
  }

  return {
    run,
    tasks,
    gates,
    transitions,
    poll_pending,
    merged,
    fix_task_ids,
  };
}
