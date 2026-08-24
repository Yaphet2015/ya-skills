export const PBENCH_RUN_STATUSES = [
  "running",
  "finishing",
  "passed",
  "blocked",
  "setup_failed",
  "agent_failed",
  "validator_failed"
] as const;

export type PbenchRunStatus = (typeof PBENCH_RUN_STATUSES)[number];
export type PbenchIntegrity = "enforced" | "instruction-only" | "unknown" | "contaminated";

export type ValidatorOutcome = {
  id: string;
  expected: "pass" | "fail";
  actual: "pass" | "fail";
  exitCode: number | null;
  stdout: string;
  stderr: string;
};
