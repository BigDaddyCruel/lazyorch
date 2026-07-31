import { RUN_PHASES, type RunPhase } from "../api/types.js";

export const PHASE_LABELS: Record<RunPhase, string> = {
  Inception: "Inception",
  Planning: "Planning",
  PlanConsensus: "Plan consensus",
  Implementing: "Implementing",
  PrePR: "Pre-PR",
  PROpen: "PR open",
  CILoop: "CI loop",
  MergeReady: "Merge ready",
  Merged: "Merged",
  Cancelled: "Cancelled",
  Failed: "Failed",
};

/** Happy-path ordered phases for the timeline (excludes terminal Cancelled/Failed). */
export const PHASE_TIMELINE: readonly RunPhase[] = [
  "Inception",
  "Planning",
  "PlanConsensus",
  "Implementing",
  "PrePR",
  "PROpen",
  "CILoop",
  "MergeReady",
  "Merged",
] as const;

export function isRunPhase(value: unknown): value is RunPhase {
  return typeof value === "string" && (RUN_PHASES as readonly string[]).includes(value);
}

export type PhaseStepState = "done" | "current" | "upcoming" | "terminal-fail" | "terminal-cancel";

export function phaseStepState(phase: string, step: RunPhase): PhaseStepState {
  if (phase === "Failed") return step === "Failed" ? "terminal-fail" : "done";
  if (phase === "Cancelled") return step === "Cancelled" ? "terminal-cancel" : "done";

  const currentIdx = PHASE_TIMELINE.indexOf(phase as RunPhase);
  const stepIdx = PHASE_TIMELINE.indexOf(step);
  if (currentIdx < 0 || stepIdx < 0) {
    return phase === step ? "current" : "upcoming";
  }
  if (stepIdx < currentIdx) return "done";
  if (stepIdx === currentIdx) return "current";
  return "upcoming";
}

export function phaseTone(phase: string): "ok" | "warn" | "err" | "info" | "muted" {
  if (phase === "Merged") return "ok";
  if (phase === "Failed") return "err";
  if (phase === "Cancelled") return "muted";
  if (phase === "PlanConsensus" || phase === "MergeReady") return "warn";
  if (
    phase === "Implementing" ||
    phase === "CILoop" ||
    phase === "PROpen" ||
    phase === "Planning"
  ) {
    return "info";
  }
  return "muted";
}
