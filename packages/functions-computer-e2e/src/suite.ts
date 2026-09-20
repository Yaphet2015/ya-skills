// Sequential fail-stop suite execution with events and truthful statuses.

import { reduceResultEvents } from "./result-reducer.js";
import { createExecutionScope, type ExecutionScope } from "@ya-skills/computer-runtime";
import type { CaseContext, Suite, SuiteResult, WorkerEvent } from "./types.js";

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

function withBudget<T>(scope: ExecutionScope, budgetMs: number, promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    scope.onDeadline(() => {
      const error = new CaseTimeoutError(budgetMs);
      scope.abort(error);
      reject(error);
    });
    promise.then(resolve, reject);
  }).finally(() => scope.dispose());
}

function guardComputer(computer: CaseContext["computer"], scope: ExecutionScope): CaseContext["computer"] {
  const signal = scope.signal;
  const refused = async (): Promise<never> => {
    throw new Error("the owning case was interrupted — no further desktop operations");
  };
  const check = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
    (...a: A): Promise<R> => {
      signal.throwIfAborted();
      return fn(...a);
    };
  const batch = async (
    target: Parameters<CaseContext["computer"]["batch"]>[0],
    request: Parameters<CaseContext["computer"]["batch"]>[1],
    callerSignal?: Parameters<CaseContext["computer"]["batch"]>[2]
  ) => {
    signal.throwIfAborted();
    const requestScope = scope.child({ signal: callerSignal });
    try {
      return await computer.batch(target, request, requestScope.signal);
    } finally {
      requestScope.dispose();
    }
  };
  return {
    apps: signal.aborted ? refused : check(computer.apps),
    windows: check(computer.windows),
    snapshot: check(computer.snapshot),
    observe: check(computer.observe),
    clickPoint: check(computer.clickPoint),
    batch,
    click: check(computer.click),
    setValue: check(computer.setValue),
    type: check(computer.type),
    key: check(computer.key),
    scroll: check(computer.scroll),
    waitFor: check(computer.waitFor)
  };
}

function wrapContext(
  context: CaseContext,
  ownerId: string,
  emit: (event: WorkerEvent) => void,
  scope?: ExecutionScope
): CaseContext {
  return {
    ...context,
    ...(scope ? { computer: guardComputer(context.computer, scope), signal: scope.signal } : {}),
    step: async <T>(name: string, work: () => Promise<T>): Promise<T> => {
      emit({ type: "step_started", payload: { caseId: ownerId, name } });
      try {
        const value = await work();
        emit({ type: "step_finished", payload: { caseId: ownerId, name, status: "passed" } });
        return value;
      } catch (error) {
        const status = error instanceof SkipError ? "interrupted" : "failed";
        const reason = errorMessage(error);
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

type HookName = "beforeAll" | "afterAll";

type SuiteHook = NonNullable<Suite[HookName]>;

async function runHook(
  name: HookName,
  hook: SuiteHook | undefined,
  suite: Suite,
  context: CaseContext,
  emit: (event: WorkerEvent) => void,
  parentScope: ExecutionScope,
  budgetMs: number
): Promise<boolean> {
  emit({ type: "hook_started", payload: { hook: name, timeoutMs: budgetMs } });
  try {
    if (hook) {
      const scope = parentScope.child({ timeoutMs: budgetMs });
      const invocation = Promise.resolve().then(() => Reflect.apply(hook, suite, [wrapContext(context, name, emit, scope)]));
      await withBudget(scope, budgetMs, invocation);
    }
    emit({ type: "hook_finished", payload: { hook: name, status: "passed" } });
    return true;
  } catch (error) {
    emit({ type: "hook_finished", payload: { hook: name, status: "failed", reason: errorMessage(error) } });
    return false;
  }
}

export async function runSuite(
  suite: Suite,
  context: CaseContext,
  emit: (event: WorkerEvent) => void
): Promise<SuiteResult> {
  const events: WorkerEvent[] = [];
  const publish = (event: WorkerEvent): void => {
    events.push(event);
    emit(event);
  };
  const hookBudget = suite.hookTimeoutMs ?? DEFAULT_CASE_TIMEOUT_MS;
  const suiteScope = createExecutionScope({ signal: context.signal });

  try {
    // The complete case list ships before any hook runs.
    publish({
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

    let stopped = !(await runHook("beforeAll", suite.beforeAll, suite, context, publish, suiteScope, hookBudget));

    for (const item of suite.tests) {
      if (stopped) continue;
      if (item.skip !== undefined) {
        publish({ type: "case_finished", payload: { caseId: item.id, status: "skipped", reason: item.skip } });
        continue;
      }
      const budget = item.timeoutMs ?? DEFAULT_CASE_TIMEOUT_MS;
      const caseScope = suiteScope.child({ timeoutMs: budget });
      publish({ type: "case_started", payload: { caseId: item.id, timeoutMs: budget } });
      try {
        const invocation = Promise.resolve().then(() => item.run(wrapContext(context, item.id, publish, caseScope)));
        await withBudget(caseScope, budget, invocation);
        publish({ type: "case_finished", payload: { caseId: item.id, status: "passed" } });
      } catch (error) {
        if (error instanceof SkipError) {
          publish({ type: "case_finished", payload: { caseId: item.id, status: "skipped", reason: error.message } });
        } else if (error instanceof CaseTimeoutError) {
          publish({ type: "case_finished", payload: { caseId: item.id, status: "interrupted", reason: error.message } });
          stopped = true;
        } else {
          const reason = errorMessage(error);
          publish({ type: "case_finished", payload: { caseId: item.id, status: "failed", reason } });
          stopped = true;
        }
      }
    }

    await runHook("afterAll", suite.afterAll, suite, context, publish, suiteScope, hookBudget);
    return reduceResultEvents(events, { stepOrder: "finish" }).suite;
  } finally {
    suiteScope.dispose();
  }
}

export function exitCodeFor(result: SuiteResult): 0 | 1 | 2 {
  if (result.errors.length > 0) return 1;
  if (result.cases.some((c) => c.status === "failed" || c.status === "interrupted")) return 1;
  if (result.cases.length === 0) return 2;
  if (result.cases.some((c) => c.status === "skipped" || c.status === "not_run")) return 2;
  return 0;
}
