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

export { runWorkerFromConfig, workerMain, type WorkerConfig } from "./worker.js";
export {
  DEFAULT_CLEANUP_GRACE_MS,
  DEFAULT_RUN_TIMEOUT_MS,
  WORKER_COMMAND,
  supervise,
  type RunOptions,
  type SuperviseOptions
} from "./supervisor.js";
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
  type ReadRunResult,
  type RunEvent,
  type RunSummary
} from "./history.js";
