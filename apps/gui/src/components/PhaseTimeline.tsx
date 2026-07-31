import { PHASE_TIMELINE, phaseStepState } from "../lib/phases.js";

export function PhaseTimeline({ phase }: { phase: string }) {
  const showFailed = phase === "Failed";
  const showCancelled = phase === "Cancelled";

  return (
    <div className="phase-timeline" role="list" aria-label="Run phase timeline">
      {PHASE_TIMELINE.map((step) => {
        const state = phaseStepState(phase, step);
        return (
          <span key={step} className={`phase-step ${state}`} role="listitem">
            {step}
          </span>
        );
      })}
      {showFailed && (
        <span className="phase-step terminal-fail" role="listitem">
          Failed
        </span>
      )}
      {showCancelled && (
        <span className="phase-step terminal-cancel" role="listitem">
          Cancelled
        </span>
      )}
    </div>
  );
}
