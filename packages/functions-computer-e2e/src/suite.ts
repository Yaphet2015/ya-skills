// Sequential fail-stop suite execution with events and truthful statuses.

import type { CaseContext, CaseResult, StepResult, Suite, SuiteResult, WorkerEvent } from "./types.js";

export type { CaseContext, CaseResult, StepResult, Suite, SuiteResult, WorkerEvent } from "./types.js";

export const DEFAULT_CASE_TIMEOUT_MS = 30_000;

// Thrown by ctx.skip; a private subclass so consumer code never imports it.
export class SkipError extends Error {}

class CaseTimeoutError extends Error {
  constructor(public budgetMs: number) {
    super(`timed out after ${budgetMs}ms`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateBudget(label: string, value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number of milliseconds`);
  }
}

export function validateSuite(value: unknown): Suite {
  if (!isPlainObject(value)) {
    throw new Error("suite must be a default-exported object");
  }
  if (value.apiVersion !== 1) {
    throw new Error(`unsupported suite apiVersion: ${String(value.apiVersion)} (expected 1)`);
  }
  if (typeof value.id !== "string" || value.id.trim() === "") {
    throw new Error("suite.id must be a non-empty string");
  }
  if (typeof value.name !== "string" || value.name.trim() === "") {
    throw new Error("suite.name must be a non-empty string");
  }
  validateBudget("suite.hookTimeoutMs", value.hookTimeoutMs);
  for (const hook of ["beforeAll", "afterAll"] as const) {
    const fn = value[hook];
    if (fn !== undefined && typeof fn !== "function") {
      throw new Error(`suite.${hook} must be a function when present`);
    }
  }
  if (!Array.isArray(value.tests) || value.tests.length === 0) {
    throw new Error("suite.tests must contain at least one test case");
  }
  const seen = new Set<string>();
  const tests = value.tests.map((raw: unknown, index: number) => {
    if (!isPlainObject(raw)) {
      throw new Error(`suite.tests[${index}] must be an object`);
    }
    if (typeof raw.id !== "string" || raw.id.trim() === "") {
      throw new Error(`suite.tests[${index}].id must be a non-empty string`);
    }
    if (seen.has(raw.id)) {
      throw new Error(`duplicate case id: ${raw.id}`);
    }
    seen.add(raw.id);
    if (typeof raw.name !== "string" || raw.name.trim() === "") {
      throw new Error(`case ${raw.id}: name must be a non-empty string`);
    }
    if (typeof raw.run !== "function") {
      throw new Error(`case ${raw.id}: run must be a function`);
    }
    validateBudget(`case ${raw.id}: timeoutMs`, raw.timeoutMs);
    if (raw.skip !== undefined && (typeof raw.skip !== "string" || raw.skip.trim() === "")) {
      throw new Error(`case ${raw.id}: skip must be a non-empty reason string`);
    }
    return raw as unknown as Suite["tests"][number];
  });
  return { ...(value as unknown as Suite), tests };
}

// Promise timeouts do not cancel the case body. Promise.race attaches
// reactions to both branches, so a late rejection of the losing promise is
// still "handled" and never surfaces as unhandled; the timer is cleared once
// the race settles.
function withBudget<T>(budgetMs: number, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CaseTimeoutError(budgetMs)), budgetMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function guardComputer(computer: CaseContext["computer"], signal: AbortSignal): CaseContext["computer"] {
  const refused = async (): Promise<never> => {
    throw new Error("the owning case was interrupted — no further desktop operations");
  };
  const check = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
    (...a: A): Promise<R> => {
      signal.throwIfAborted();
      return fn(...a);
    };
  // Batch is the one facade method whose runtime contract accepts the
  // owning request signal. Passing it through the case guard is essential:
  // checking only before the call leaves an already admitted multi-action
  // batch free to dispatch later actions after a case timeout (including
  // while afterAll is running).
  const batch = (
    target: Parameters<CaseContext["computer"]["batch"]>[0],
    request: Parameters<CaseContext["computer"]["batch"]>[1]
  ) => {
    signal.throwIfAborted();
    return computer.batch(target, request, signal);
  };
  return {
    apps: signal.aborted ? refused : check(computer.apps),
    windows: check(computer.windows),
    snapshot: check(computer.snapshot),
    observe: check(computer.observe),
    clickPoint: check(computer.clickPoint),
    batch,
    click: check(computer.click),
    type: check(computer.type),
    key: check(computer.key),
    scroll: check(computer.scroll),
    waitFor: check(computer.waitFor)
  };
}

function wrapContext(
  context: CaseContext,
  ownerId: string,
  steps: StepResult[],
  emit: (event: WorkerEvent) => void,
  signal?: AbortSignal
): CaseContext {
  return {
    ...context,
    ...(signal ? { computer: guardComputer(context.computer, signal), signal } : {}),
    step: async <T>(name: string, work: () => Promise<T>): Promise<T> => {
      emit({ type: "step_started", payload: { caseId: ownerId, name } });
      try {
        const value = await work();
        steps.push({ caseId: ownerId, name, status: "passed" });
        emit({ type: "step_finished", payload: { caseId: ownerId, name, status: "passed" } });
        return value;
      } catch (error) {
        const status = error instanceof SkipError ? "interrupted" : "failed";
        const reason = errorMessage(error);
        steps.push({ caseId: ownerId, name, status, reason });
        emit({ type: "step_finished", payload: { caseId: ownerId, name, status, reason } });
        throw error;
      }
    },
    skip: (reason: string): never => {
      if (typeof reason !== "string" || reason.trim() === "") {
        throw new Error("skip() requires a non-empty reason");
      }
      throw new SkipError(reason);
    }
  };
}

export async function runSuite(
  suite: Suite,
  context: CaseContext,
  emit: (event: WorkerEvent) => void
): Promise<SuiteResult> {
  const cases: CaseResult[] = [];
  const steps: StepResult[] = [];
  const errors: SuiteResult["errors"] = [];
  const hookBudget = suite.hookTimeoutMs ?? DEFAULT_CASE_TIMEOUT_MS;

  // The complete case list ships before any hook runs.
  emit({
    type: "suite_collected",
    payload: {
      cases: suite.tests.map((t) => ({
        id: t.id,
        name: t.name,
        timeoutMs: t.timeoutMs ?? DEFAULT_CASE_TIMEOUT_MS,
        ...(t.skip !== undefined ? { skip: t.skip } : {})
      }))
    }
  });

  let stopped = false;

  emit({ type: "hook_started", payload: { hook: "beforeAll", timeoutMs: hookBudget } });
  try {
    if (suite.beforeAll) await withBudget(hookBudget, Promise.resolve(suite.beforeAll(wrapContext(context, "beforeAll", steps, emit))));
    emit({ type: "hook_finished", payload: { hook: "beforeAll", status: "passed" } });
  } catch (error) {
    errors.push({ phase: "beforeAll", message: errorMessage(error) });
    stopped = true;
    emit({ type: "hook_finished", payload: { hook: "beforeAll", status: "failed", reason: errorMessage(error) } });
  }

  for (const item of suite.tests) {
    if (stopped) {
      cases.push({ id: item.id, name: item.name, status: "not_run" });
      continue;
    }
    // Per-case abort: a timed-out case's zombie promise must not keep
    // delivering desktop actions during afterAll.
    const caseController = new AbortController();
    const propagate = () => caseController.abort();
    context.signal.addEventListener("abort", propagate, { once: true });
    if (item.skip !== undefined) {
      cases.push({ id: item.id, name: item.name, status: "skipped", reason: item.skip });
      emit({ type: "case_finished", payload: { caseId: item.id, status: "skipped", reason: item.skip } });
      continue;
    }
    const budget = item.timeoutMs ?? DEFAULT_CASE_TIMEOUT_MS;
    emit({ type: "case_started", payload: { caseId: item.id, timeoutMs: budget } });
    try {
      await withBudget(budget, Promise.resolve(item.run(wrapContext(context, item.id, steps, emit, caseController.signal))));
      cases.push({ id: item.id, name: item.name, status: "passed" });
      emit({ type: "case_finished", payload: { caseId: item.id, status: "passed" } });
    } catch (error) {
      if (error instanceof SkipError) {
        cases.push({ id: item.id, name: item.name, status: "skipped", reason: error.message });
        emit({ type: "case_finished", payload: { caseId: item.id, status: "skipped", reason: error.message } });
      } else if (error instanceof CaseTimeoutError) {
        caseController.abort();
        cases.push({ id: item.id, name: item.name, status: "interrupted", reason: error.message });
        emit({ type: "case_finished", payload: { caseId: item.id, status: "interrupted", reason: error.message } });
        stopped = true;
      } else {
        const reason = errorMessage(error);
        cases.push({ id: item.id, name: item.name, status: "failed", reason });
        errors.push({ phase: "case", message: `${item.id}: ${reason}` });
        emit({ type: "case_finished", payload: { caseId: item.id, status: "failed", reason } });
        stopped = true;
      }
    }
    context.signal.removeEventListener("abort", propagate);
  }

  emit({ type: "hook_started", payload: { hook: "afterAll", timeoutMs: hookBudget } });
  try {
    if (suite.afterAll) await withBudget(hookBudget, Promise.resolve(suite.afterAll(wrapContext(context, "afterAll", steps, emit))));
    emit({ type: "hook_finished", payload: { hook: "afterAll", status: "passed" } });
  } catch (error) {
    errors.push({ phase: "afterAll", message: errorMessage(error) });
    emit({ type: "hook_finished", payload: { hook: "afterAll", status: "failed", reason: errorMessage(error) } });
  }

  return { cases, steps, errors };
}

export function exitCodeFor(result: SuiteResult): 0 | 1 | 2 {
  if (result.errors.length > 0) return 1;
  if (result.cases.some((c) => c.status === "failed" || c.status === "interrupted")) return 1;
  if (result.cases.length === 0) return 2;
  if (result.cases.some((c) => c.status === "skipped" || c.status === "not_run")) return 2;
  return 0;
}
