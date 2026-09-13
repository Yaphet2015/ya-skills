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
