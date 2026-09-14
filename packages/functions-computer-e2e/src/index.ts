// Public surface of the e2e executor. Importing this module must never load
// the desktop SDK — lazy session creation happens inside the worker only.

export {
  DEFAULT_CASE_TIMEOUT_MS,
  SkipError,
  exitCodeFor,
  runSuite,
  validateSuite
} from "./suite.js";
export type {
  CaseContext,
  CaseResult,
  CaseStatus,
  StepResult,
  Suite,
  SuiteResult,
  TestCase,
  WorkerEvent,
  WorkerEventType
} from "./types.js";
export type { ApplicationInfo } from "./context.js";
export { createComputerE2ECommands } from "./commands.js";
export { parseE2EArgs, E2E_USAGE, DEFAULT_OUT_DIR, DEFAULT_HISTORY_LIMIT, type E2ERequest } from "./args.js";

export { runWorkerFromConfig, workerMain, type WorkerConfig } from "./worker.js";
export {
  DEFAULT_CLEANUP_GRACE_MS,
  WORKER_COMMAND,
  supervise,
  type RunOptions,
  type SuperviseOptions
} from "./supervisor.js";
export { DEFAULT_RUN_TIMEOUT_MS } from "./args.js";
export {
  ARTIFACTS_DIR,
  EVENTS_FILE,
  REPORT_FILE,
  SUMMARY_FILE,
  createRunDir,
  eventLine,
  formatReport,
  readHistory,
  readRun,
  reduceEvents,
  type RunEvent,
  type RunSummary
} from "./history.js";
