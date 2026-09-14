// Consumer-facing suite contract (apiVersion 1) plus the worker event union.
// The Computer/Target types come from the shared runtime; importing this
// module must never touch the SDK.

import type { ApplicationInfo } from "./context.js";

export type { ApplicationInfo } from "./context.js";
import type { Computer, Target } from "@ya-skills/computer-runtime";

export type {
  AppRef,
  AxElement,
  Computer,
  Predicate,
  ScrollDirection,
  ScrollSpec,
  Snapshot,
  Target,
  WindowRef
} from "@ya-skills/computer-runtime";

export interface CaseContext {
  computer: Computer;
  signal: AbortSignal;
  params: Readonly<Record<string, string>>;
  artifactsDir: string;
  step<T>(name: string, work: () => Promise<T>): Promise<T>;
  skip(reason: string): never;
  setApplication(info: ApplicationInfo): void;
  capture(target: Target, name: string): Promise<{ elementsPath: string; screenshotPath?: string }>;
}

export interface TestCase {
  id: string;
  name: string;
  timeoutMs?: number;
  skip?: string;
  run(context: CaseContext): Promise<void> | void;
}

export interface Suite {
  apiVersion: 1;
  id: string;
  name: string;
  hookTimeoutMs?: number;
  beforeAll?(context: CaseContext): Promise<void> | void;
  afterAll?(context: CaseContext): Promise<void> | void;
  tests: TestCase[];
}

export type CaseStatus = "passed" | "failed" | "skipped" | "not_run" | "interrupted";

export interface CaseResult {
  id: string;
  name: string;
  status: CaseStatus;
  reason?: string;
}

export interface StepResult {
  caseId: string;
  name: string;
  status: "passed" | "failed" | "interrupted";
  reason?: string;
}

export interface SuiteResult {
  cases: CaseResult[];
  steps: StepResult[];
  errors: Array<{ phase: "load" | "beforeAll" | "case" | "afterAll" | "driver"; message: string }>;
}

// Everything except run_started/run_finished, which the parent process adds.
export type WorkerEventType =
  | "runtime"
  | "suite_collected"
  | "hook_started"
  | "hook_finished"
  | "case_started"
  | "case_finished"
  | "step_started"
  | "step_finished"
  | "action_started"
  | "action_finished"
  | "application"
  | "artifact";

export interface WorkerEvent {
  type: WorkerEventType;
  payload: Record<string, unknown>;
}
