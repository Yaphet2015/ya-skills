import type { CaseResult, CaseStatus, StepResult, SuiteResult } from "./types.js";

export interface ResultEvent {
  type: string;
  payload?: Record<string, unknown>;
}

export interface ResultReducerOptions {
  caseId?: (file: string | undefined, id: string) => string;
  includeInterruptedErrors?: boolean;
  includeOpenSteps?: boolean;
  stepOrder?: "start" | "finish";
}

export interface ResultReduction {
  suite: SuiteResult;
  errors: string[];
  artifacts: string[];
}

interface CollectedCase {
  name: string;
  started: boolean;
  finished?: { status: CaseStatus; reason?: string };
}

interface RecordedStep {
  result: StepResult;
  open: boolean;
  finishedAt?: number;
}

function defaultCaseId(file: string | undefined, id: string): string {
  return file === undefined ? id : `${file}::${id}`;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function caseStatus(value: unknown): CaseStatus {
  return asString(value) as CaseStatus;
}

function stepStatus(value: unknown): StepResult["status"] {
  if (value === "failed") return "failed";
  if (value === "interrupted") return "interrupted";
  return "passed";
}

function artifactWithinRun(path: string): boolean {
  // Artifacts are recorded relative to the run dir; traversal out is refused.
  if (path.startsWith("/")) return false;
  const parts = path.split("/");
  let depth = 0;
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      depth--;
      if (depth < 0) return false;
    } else depth++;
  }
  return true;
}

export function reduceResultEvents(events: readonly ResultEvent[], options: ResultReducerOptions = {}): ResultReduction {
  const formatCaseId = options.caseId ?? defaultCaseId;
  const includeInterruptedErrors = options.includeInterruptedErrors ?? false;
  const includeOpenSteps = options.includeOpenSteps ?? false;
  const stepOrder = options.stepOrder ?? "start";
  const collected = new Map<string, CollectedCase>();
  const steps: RecordedStep[] = [];
  let finishedStepCount = 0;
  const recordedErrors: SuiteResult["errors"] = [];
  const artifacts: string[] = [];
  const openActions = new Set<string>();

  function caseReference(payload: Record<string, unknown>): string {
    const id = asString(payload.id) ?? asString(payload.caseId) ?? "<unknown>";
    return formatCaseId(asString(payload.file), id);
  }

  function addCaseFailure(payload: Record<string, unknown>, status: CaseStatus, reason?: string): void {
    if (status !== "failed" && !(status === "interrupted" && includeInterruptedErrors)) return;
    const message = `${caseReference(payload)}: ${reason ?? status}`;
    recordedErrors.push({ phase: "case", message });
  }

  function addHookFailure(payload: Record<string, unknown>): void {
    const hook = asString(payload.hook) ?? "hook";
    const reason = asString(payload.reason) ?? "failed";
    const suiteHook = hook === "beforeAll" || hook === "afterAll";
    const message = suiteHook ? reason : `${hook}: ${reason}`;
    recordedErrors.push({ phase: suiteHook ? hook : "driver", message });
  }

  function addDriverError(message: string): void {
    recordedErrors.push({ phase: "driver", message });
  }

  function recordSuiteCollected(payload: Record<string, unknown>): void {
    const loadError = asString(payload.loadError);
    if (loadError !== undefined) {
      const file = asString(payload.file) ?? "<unknown>";
      recordedErrors.push({ phase: "load", message: `${file}: ${loadError}` });
      return;
    }
    const file = asString(payload.file);
    for (const raw of Array.isArray(payload.cases) ? payload.cases : []) {
      const item = raw as { id?: unknown; name?: unknown };
      const id = asString(item.id) ?? "<unknown>";
      const key = formatCaseId(file, id);
      if (!collected.has(key)) {
        collected.set(key, { name: asString(item.name) ?? id, started: false });
      }
    }
  }

  function recordStepStarted(payload: Record<string, unknown>): void {
    const caseId = formatCaseId(asString(payload.file), asString(payload.caseId) ?? "<unknown>");
    const name = asString(payload.name) ?? "<unnamed>";
    steps.push({ result: { caseId, name, status: "passed" }, open: true });
  }

  function recordStepFinished(payload: Record<string, unknown>): void {
    const caseId = formatCaseId(asString(payload.file), asString(payload.caseId) ?? "<unknown>");
    const name = asString(payload.name) ?? "<unnamed>";
    const status = stepStatus(payload.status);
    const reason = asString(payload.reason);
    const last = [...steps].reverse().find((step) => step.open && step.result.caseId === caseId && step.result.name === name);
    if (last) {
      last.result.status = status;
      if (reason) last.result.reason = reason;
      last.open = false;
      last.finishedAt = finishedStepCount++;
      return;
    }
    steps.push({ result: { caseId, name, status, reason }, open: false });
  }

  function apply(event: ResultEvent): void {
    const payload = event.payload ?? {};
    switch (event.type) {
      case "suite_collected":
        recordSuiteCollected(payload);
        break;
      case "case_started": {
        const entry = collected.get(caseReference(payload));
        if (entry) entry.started = true;
        break;
      }
      case "case_finished": {
        const id = caseReference(payload);
        const status = caseStatus(payload.status);
        const reason = asString(payload.reason);
        const entry = collected.get(id);
        if (entry) {
          entry.started = true;
          entry.finished = { status, reason };
        }
        addCaseFailure(payload, status, reason);
        break;
      }
      case "step_started":
        recordStepStarted(payload);
        break;
      case "step_finished":
        recordStepFinished(payload);
        break;
      case "action_started":
        openActions.add(asString(payload.kind) ?? "unknown");
        break;
      case "action_finished":
        openActions.delete(asString(payload.kind) ?? "unknown");
        break;
      case "hook_finished":
        if (asString(payload.status) === "failed") addHookFailure(payload);
        break;
      case "artifact": {
        const path = asString(payload.path);
        if (path === undefined) break;
        if (!artifactWithinRun(path)) addDriverError(`artifact path escapes the run directory: ${path}`);
        else artifacts.push(path);
        break;
      }
      case "worker_protocol_error":
        addDriverError(`worker protocol error in ${asString(payload.file) ?? "<unknown file>"}: ${asString(payload.reason) ?? "unknown"}`);
        break;
      default:
        break;
    }
  }

  function finish(): ResultReduction {
    const finalErrors = recordedErrors.map((error) => {
      if (error.phase === "beforeAll" || error.phase === "afterAll") return `${error.phase}: ${error.message}`;
      return error.message;
    });
    const finalSuiteErrors = [...recordedErrors];
    for (const kind of openActions) {
      const message = `action outcome unknown: ${kind} started but never finished (no replay)`;
      finalErrors.push(message);
      finalSuiteErrors.push({ phase: "driver", message });
    }

    const cases: CaseResult[] = [...collected].map(([key, entry]) => {
      const status = entry.finished?.status ?? (entry.started ? "interrupted" : "not_run");
      return {
        id: key,
        name: entry.name,
        status,
        ...(entry.finished?.reason !== undefined ? { reason: entry.finished.reason } : {})
      };
    });
    const resolvedStepRecords = steps.filter((step) => includeOpenSteps || !step.open);
    if (stepOrder === "finish") {
      resolvedStepRecords.sort((left, right) => (left.finishedAt ?? Infinity) - (right.finishedAt ?? Infinity));
    }
    const resolvedSteps = resolvedStepRecords.map((step) => ({ ...step.result }));

    return {
      suite: { cases, steps: resolvedSteps, errors: finalSuiteErrors },
      errors: finalErrors,
      artifacts: [...artifacts]
    };
  }

  for (const event of events) apply(event);
  return finish();
}
