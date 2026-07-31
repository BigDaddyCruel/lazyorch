import { describe, expect, it } from "vitest";
import { phaseStepState, phaseTone } from "./phases.js";

describe("phaseStepState", () => {
  it("marks steps relative to Implementing", () => {
    expect(phaseStepState("Implementing", "Planning")).toBe("done");
    expect(phaseStepState("Implementing", "Implementing")).toBe("current");
    expect(phaseStepState("Implementing", "Merged")).toBe("upcoming");
  });

  it("handles terminal Failed", () => {
    expect(phaseStepState("Failed", "Failed")).toBe("terminal-fail");
    expect(phaseStepState("Failed", "Inception")).toBe("done");
  });

  it("handles terminal Cancelled", () => {
    expect(phaseStepState("Cancelled", "Cancelled")).toBe("terminal-cancel");
  });
});

describe("phaseTone", () => {
  it("returns semantic tones", () => {
    expect(phaseTone("Merged")).toBe("ok");
    expect(phaseTone("Failed")).toBe("err");
    expect(phaseTone("PlanConsensus")).toBe("warn");
    expect(phaseTone("Implementing")).toBe("info");
  });
});
