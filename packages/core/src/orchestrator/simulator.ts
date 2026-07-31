import { depsSatisfied, readyWhenDepsDone } from "../dag.js";
import type { PrRef, Run } from "../types/run.js";
import type { Task } from "../types/task.js";
import {
  canExitImplementing,
  evaluatingImplementingExit,
  type ExitPredicateParams,
} from "./exit-predicate.js";
import {
  nextPhaseAfterImplementingExit,
  transitionRunPhase,
  type TransitionRunOptions,
} from "./run-fsm.js";
import {
  transitionTaskStatus,
  type TransitionTaskOptions,
} from "./task-fsm.js";

/**
 * In-memory multi-task run state for pure simulation (no adapters, no git).
 */
export interface SimState {
  run: Run;
  tasks: Task[];
}

export type SimEvent =
  | {
      type: "run_transition";
      to: Run["phase"];
      options?: TransitionRunOptions;
    }
  | {
      type: "task_transition";
      task_id: string;
      to: Task["status"];
      options?: TransitionTaskOptions;
    }
  | {
      type: "set_feature_tip";
      sha: string;
    }
  | {
      type: "set_qa_passed";
      /** Defaults to current feature_tip_sha */
      at_commit?: string;
    }
  | {
      type: "set_pr";
      pr: PrRef | undefined;
    }
  | {
      /**
       * Under Implementing: promote todo→ready when deps done,
       * then optionally advance all ready/in_progress/review/integrating
       * one hop along the happy path (parallel).
       */
      type: "advance_parallel";
      /** Max concurrent in_progress tasks (default: unlimited) */
      max_concurrent?: number;
    }
  | {
      /**
       * If Implementing exit predicate holds, transition run to PrePR or CILoop.
       */
      type: "try_exit_implementing";
      params?: ExitPredicateParams;
    };

export class SimulatorError extends Error {
  readonly code: "unknown_task" | "wrong_phase" | "exit_not_ready";

  constructor(code: SimulatorError["code"], message: string) {
    super(message);
    this.name = "SimulatorError";
    this.code = code;
  }
}

function replaceTask(tasks: Task[], next: Task): Task[] {
  return tasks.map((t) => (t.id === next.id ? next : t));
}

/**
 * Apply a single simulation event. Pure: returns a new state.
 * Illegal FSM edges bubble as RunFsmError / TaskFsmError.
 */
export function applySimEvent(state: SimState, event: SimEvent): SimState {
  switch (event.type) {
    case "run_transition": {
      return {
        ...state,
        run: transitionRunPhase(state.run, event.to, event.options),
      };
    }
    case "task_transition": {
      const task = state.tasks.find((t) => t.id === event.task_id);
      if (!task) {
        throw new SimulatorError(
          "unknown_task",
          `Unknown task id: ${event.task_id}`,
        );
      }
      return {
        ...state,
        tasks: replaceTask(
          state.tasks,
          transitionTaskStatus(task, event.to, event.options),
        ),
      };
    }
    case "set_feature_tip": {
      return {
        ...state,
        run: {
          ...state.run,
          feature_tip_sha: event.sha,
          updated_at: new Date().toISOString(),
        },
      };
    }
    case "set_qa_passed": {
      const at =
        event.at_commit ?? state.run.feature_tip_sha ?? "";
      return {
        ...state,
        run: {
          ...state.run,
          qa: { passed_at_commit: at },
          updated_at: new Date().toISOString(),
        },
      };
    }
    case "set_pr": {
      const run: Run = {
        ...state.run,
        updated_at: new Date().toISOString(),
      };
      if (event.pr === undefined) {
        delete run.pr_ref;
      } else {
        run.pr_ref = event.pr;
      }
      return { ...state, run };
    }
    case "advance_parallel": {
      return advanceParallel(state, event.max_concurrent);
    }
    case "try_exit_implementing": {
      return tryExitImplementing(state, event.params);
    }
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

/** Apply a sequence of events. */
export function applySimEvents(
  state: SimState,
  events: readonly SimEvent[],
): SimState {
  return events.reduce((s, e) => applySimEvent(s, e), state);
}

/**
 * One simulation tick under Implementing:
 * 1. todo → ready when deps satisfied
 * 2. ready → in_progress up to max_concurrent slots
 * 3. in_progress → review
 * 4. review → integrating
 * 5. integrating → done (and bump feature tip so re-QA is needed)
 *
 * All eligible tasks of the same step advance in one call (parallel model).
 * Does not exit Implementing — use try_exit_implementing after QA.
 */
export function advanceParallel(
  state: SimState,
  maxConcurrent?: number,
): SimState {
  if (state.run.phase !== "Implementing") {
    throw new SimulatorError(
      "wrong_phase",
      `advance_parallel requires Implementing, got ${state.run.phase}`,
    );
  }

  let tasks = [...state.tasks];
  let run = state.run;
  // Snapshot pipeline statuses at tick start so ready→in_progress does not
  // also hop to review in the same call.
  const startInProgress = tasks.filter((x) => x.status === "in_progress");
  const startReview = tasks.filter((x) => x.status === "review");
  const startIntegrating = tasks.filter((x) => x.status === "integrating");
  const byId = () => new Map(tasks.map((t) => [t.id, t]));

  // 1) Promote todo → ready
  for (const t of readyWhenDepsDone(tasks)) {
    tasks = replaceTask(tasks, transitionTaskStatus(t, "ready"));
  }

  // 2) ready → in_progress (respect concurrency)
  const inFlight = tasks.filter((t) => t.status === "in_progress").length;
  const limit = maxConcurrent ?? Number.POSITIVE_INFINITY;
  let slots = Math.max(0, limit - inFlight);
  const ready = tasks
    .filter((t) => t.status === "ready")
    .filter((t) => depsSatisfied(t, byId()))
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

  for (const t of ready) {
    if (slots <= 0) break;
    tasks = replaceTask(
      tasks,
      transitionTaskStatus(t, "in_progress", {
        assignee: t.assignee ?? "sim_worker",
      }),
    );
    slots -= 1;
  }

  // 3–5) One hop per stage from start-of-tick snapshot
  for (const t of startInProgress) {
    const cur = tasks.find((x) => x.id === t.id);
    if (cur?.status === "in_progress") {
      tasks = replaceTask(tasks, transitionTaskStatus(cur, "review"));
    }
  }
  for (const t of startReview) {
    const cur = tasks.find((x) => x.id === t.id);
    if (cur?.status === "review") {
      tasks = replaceTask(tasks, transitionTaskStatus(cur, "integrating"));
    }
  }

  let integrated = false;
  for (const t of startIntegrating) {
    const cur = tasks.find((x) => x.id === t.id);
    if (cur?.status === "integrating") {
      tasks = replaceTask(tasks, transitionTaskStatus(cur, "done"));
      integrated = true;
    }
  }

  // Successful integrate advances feature tip and invalidates prior QA
  if (integrated) {
    const tip = `sim_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    run = {
      ...run,
      feature_tip_sha: tip,
      updated_at: new Date().toISOString(),
    };
    if (run.qa?.passed_at_commit !== tip) {
      delete run.qa;
    }
  }

  return { run, tasks };
}

/**
 * If exit predicate holds while in Implementing, move to PrePR or CILoop.
 */
export function tryExitImplementing(
  state: SimState,
  params?: ExitPredicateParams,
): SimState {
  if (state.run.phase !== "Implementing") {
    throw new SimulatorError(
      "wrong_phase",
      `try_exit_implementing requires Implementing, got ${state.run.phase}`,
    );
  }
  const result = evaluatingImplementingExit(state.run, state.tasks, params);
  if (!result.ok) {
    throw new SimulatorError(
      "exit_not_ready",
      `Implementing exit predicate not met: ${result.reasons.join("; ")}`,
    );
  }
  const to = nextPhaseAfterImplementingExit(state.run.pr_ref);
  return {
    ...state,
    run: transitionRunPhase(state.run, to),
  };
}

/**
 * Drive a multi-task Implementing run to completion without adapters:
 * repeatedly advance_parallel until no open work, set QA to tip, then exit.
 * Returns final state (PrePR or CILoop) or stays Implementing if stuck.
 */
export function simulateImplementingToExit(
  state: SimState,
  options: {
    max_ticks?: number;
    max_concurrent?: number;
    /** If true, pass skip_qa_check on exit (default false — sets QA to tip). */
    auto_qa?: boolean;
  } = {},
): SimState {
  const maxTicks = options.max_ticks ?? 64;
  let s = state;

  if (s.run.phase !== "Implementing") {
    throw new SimulatorError(
      "wrong_phase",
      `simulateImplementingToExit requires Implementing, got ${s.run.phase}`,
    );
  }

  for (let i = 0; i < maxTicks; i++) {
    const open = s.tasks.some(
      (t) => t.status !== "done" && t.status !== "cancelled",
    );
    if (!open) break;
    s = advanceParallel(s, options.max_concurrent);
  }

  if (options.auto_qa !== false) {
    if (s.run.feature_tip_sha) {
      s = applySimEvent(s, { type: "set_qa_passed" });
    }
  }

  if (canExitImplementing(s.run, s.tasks)) {
    s = tryExitImplementing(s);
  }

  return s;
}
