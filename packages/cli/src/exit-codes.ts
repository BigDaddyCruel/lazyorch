/**
 * CLI exit codes (design-lazyorch.md).
 *
 * 0 ok · 1 error · 2 usage · 3 gate required · 4 adapter missing ·
 * 5 plan not consensus/validators · 6 multi-PR not implemented
 */
export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  GATE: 3,
  ADAPTER_MISSING: 4,
  PLAN: 5,
  MULTI_PR: 6,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
