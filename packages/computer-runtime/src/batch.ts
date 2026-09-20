// Bounded serial action batches (A5). Full structural validation happens
// BEFORE any driver call; execution is strictly serial on one target;
// receipts distinguish delivered / not_delivered / unknown / satisfied /
// not_run. An unknown delivery poisons the run: remaining steps are not_run
// and the batch never auto-replays.

import type {
  ActionReceipt,
  BatchAction,
  BatchRequest,
  BatchResult,
  Computer,
  Condition,
  Selector,
  Target
} from "./types.js";
import { completeFinalObservation } from "./request-execution.js";
import { executeStep } from "./step-execution.js";

export const DEFAULT_MAX_ACTIONS = 5;
export const MAX_ACTIONS_LIMIT = 20;
export const DEFAULT_BATCH_TIMEOUT_MS = 30_000;
export const MAX_BATCH_TIMEOUT_MS = 120_000;
const MAX_TEXT_LENGTH = 10_000;
const MAX_ELEMENT_TOKEN_LENGTH = 256;
const MAX_VALUE_LENGTH = 256 * 1024;

function fail(message: string): never {
  throw new Error(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validateSelector(value: unknown, where: string): Selector {
  if (!isObject(value)) fail(`${where} must be an object`);
  const text = value.text;
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_TEXT_LENGTH) {
    fail(`${where}.text must be a non-empty string`);
  }
  const match = value.match;
  if (match !== "exact" && match !== "contains") {
    fail(`${where}.match must be "exact" or "contains"`);
  }
  const role = value.role;
  if (role !== undefined && (typeof role !== "string" || role.length === 0)) {
    fail(`${where}.role must be a non-empty string`);
  }
  return { text, match, ...(role !== undefined ? { role } : {}) };
}

function validateCondition(value: unknown, where: string): Condition {
  if (!isObject(value)) fail(`${where} must be an object`);
  const kind = value.kind;
  if (kind === "element_exists") {
    return { kind, selector: validateSelector(value.selector, `${where}.selector`) };
  }
  if (kind === "element_value") {
    const v = value.value;
    if (typeof v !== "string" || v.length > MAX_TEXT_LENGTH) {
      fail(`${where}.value must be a string`);
    }
    return { kind, selector: validateSelector(value.selector, `${where}.selector`), value: v };
  }
  if (kind === "window_exists") {
    return { kind };
  }
  if (kind === "focused_element") {
    // Structurally accepted (so validation errors are caught early) but the
    // evaluator rejects it at runtime with unsupported_condition.
    return { kind, selector: validateSelector(value.selector, `${where}.selector`) };
  }
  fail(`${where}.kind must be element_exists|element_value|window_exists|focused_element`);
}

function validateFiniteNumber(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${where} must be a finite number`);
  }
  return value;
}

function validateScrollSpec(value: unknown, where: string): { direction: "up" | "down" | "left" | "right"; amount: number; x: number; y: number } {
  if (!isObject(value)) fail(`${where} must be an object`);
  const direction = value.direction;
  if (direction !== "up" && direction !== "down" && direction !== "left" && direction !== "right") {
    fail(`${where}.direction must be up|down|left|right`);
  }
  const amount = validateFiniteNumber(value.amount, `${where}.amount`);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 100) {
    fail(`${where}.amount must be a positive integer <= 100`);
  }
  const x = validateFiniteNumber(value.x, `${where}.x`);
  const y = validateFiniteNumber(value.y, `${where}.y`);
  if (x < 0 || y < 0) fail(`${where}.x/.y must be non-negative`);
  return { direction, amount, x, y };
}

function validatePointClick(value: unknown, where: string): { observationId: string; x: number; y: number } {
  if (!isObject(value)) fail(`${where} must be an object`);
  const observationId = value.observationId;
  if (typeof observationId !== "string" || !/^[0-9a-f-]{36}$/i.test(observationId)) {
    fail(`${where}.observationId must be a UUID (observe first)`);
  }
  const x = validateFiniteNumber(value.x, `${where}.x`);
  const y = validateFiniteNumber(value.y, `${where}.y`);
  if (x < 0 || y < 0) fail(`${where}.x/.y must be non-negative image pixel coordinates`);
  return { observationId, x, y };
}

function validateAction(value: unknown, index: number): BatchAction {
  const where = `actions[${index}]`;
  if (!isObject(value)) fail(`${where} must be an object`);
  const kind = value.kind;
  const v = value;
  switch (kind) {
    case "click":
      return { kind, selector: validateSelector(v.selector, `${where}.selector`) };
    case "click_point":
      return { kind, point: validatePointClick(v.point, `${where}.point`) };
    case "set_value": {
      const elementToken = v.elementToken;
      if (typeof elementToken !== "string" || elementToken.trim().length === 0 || Buffer.byteLength(elementToken, "utf8") > MAX_ELEMENT_TOKEN_LENGTH) {
        fail(`${where}.elementToken must be a non-empty string <= ${MAX_ELEMENT_TOKEN_LENGTH} UTF-8 bytes`);
      }
      const value = v.value;
      if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_VALUE_LENGTH) {
        fail(`${where}.value must be a string <= ${MAX_VALUE_LENGTH} UTF-8 bytes`);
      }
      return { kind, elementToken, value };
    }
    case "type": {
      const text = v.text;
      if (typeof text !== "string" || text.length === 0 || text.length > MAX_TEXT_LENGTH) {
        fail(`${where}.text must be a non-empty string`);
      }
      const before = v.before === undefined ? undefined : validateCondition(v.before, `${where}.before`);
      return before ? { kind, text, before } : { kind, text };
    }
    case "key": {
      const key = v.key;
      if (typeof key !== "string" || key.length === 0 || key.length > 64) {
        fail(`${where}.key must be a non-empty string`);
      }
      const modifiers = v.modifiers;
      if (modifiers !== undefined) {
        if (!Array.isArray(modifiers) || modifiers.some((m) => typeof m !== "string" || m.length === 0)) {
          fail(`${where}.modifiers must be an array of strings`);
        }
      }
      const before = v.before === undefined ? undefined : validateCondition(v.before, `${where}.before`);
      return {
        kind,
        key,
        ...(modifiers !== undefined ? { modifiers: modifiers as string[] } : {}),
        ...(before !== undefined ? { before } : {})
      };
    }
    case "scroll":
      return { kind, spec: validateScrollSpec(v.spec, `${where}.spec`) };
    case "wait": {
      const timeoutMs = validateFiniteNumber(v.timeoutMs, `${where}.timeoutMs`);
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_BATCH_TIMEOUT_MS) {
        fail(`${where}.timeoutMs must be a positive integer <= ${MAX_BATCH_TIMEOUT_MS}`);
      }
      return { kind, condition: validateCondition(v.condition, `${where}.condition`), timeoutMs };
    }
    default:
      fail(`${where}.kind must be click|click_point|set_value|type|key|scroll|wait`);
  }
}

/** Structural + budget validation of the whole request. Runs BEFORE any
 * driver work: one invalid step rejects the entire batch. */
export function validateBatch(value: unknown): BatchRequest {
  if (!isObject(value)) fail("batch request must be an object");
  const rawActions = value.actions;
  if (!Array.isArray(rawActions) || rawActions.length === 0) {
    fail("batch request needs a non-empty actions array");
  }
  const requestedMax = value.maxActions;
  let parsedMax: number | undefined;
  if (requestedMax !== undefined) {
    const n = validateFiniteNumber(requestedMax, "maxActions");
    if (!Number.isSafeInteger(n) || n <= 0 || n > MAX_ACTIONS_LIMIT) {
      fail(`maxActions must be a positive integer <= ${MAX_ACTIONS_LIMIT}`);
    }
    parsedMax = n;
  }
  const maxActions = Math.min(parsedMax ?? DEFAULT_MAX_ACTIONS, MAX_ACTIONS_LIMIT);
  if (rawActions.length > maxActions) {
    fail(`batch has ${rawActions.length} actions but the limit is ${maxActions} (raise with maxActions, hard cap ${MAX_ACTIONS_LIMIT})`);
  }
  const timeoutMs = value.timeoutMs;
  let parsedTimeout: number | undefined;
  if (timeoutMs !== undefined) {
    const t = validateFiniteNumber(timeoutMs, "timeoutMs");
    if (!Number.isSafeInteger(t) || t <= 0 || t > MAX_BATCH_TIMEOUT_MS) {
      fail(`timeoutMs must be a positive integer <= ${MAX_BATCH_TIMEOUT_MS}`);
    }
    parsedTimeout = t;
  }
  const observe = value.observe;
  if (observe !== undefined) {
    if (!isObject(observe)) fail("observe must be an object");
    const mode = observe.mode;
    if (mode !== undefined && mode !== "auto" && mode !== "ax" && mode !== "image" && mode !== "both") {
      fail("observe.mode must be auto|ax|image|both");
    }
    const maxDimension = (observe as Record<string, unknown>).maxDimension;
    if (maxDimension !== undefined) {
      const d = validateFiniteNumber(maxDimension, "observe.maxDimension");
      if (!Number.isSafeInteger(d) || d < 64 || d > 8192) {
        fail("observe.maxDimension must be an integer between 64 and 8192");
      }
    }
    if ((observe as Record<string, unknown>).selector !== undefined) {
      validateSelector((observe as Record<string, unknown>).selector, "observe.selector");
    }
  }
  return {
    actions: rawActions.map((a, i) => validateAction(a, i)),
    ...(observe !== undefined ? { observe: observe as BatchRequest["observe"] } : {}),
    ...(parsedTimeout !== undefined ? { timeoutMs: parsedTimeout } : {}),
    ...(parsedMax !== undefined ? { maxActions: parsedMax } : {})
  };
}

export interface BatchDeps {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Public batch executor. Step delivery is shared with hosted and scripted
 * request paths; this function keeps the public batch result and deadline
 * behavior stable. */
export async function runBatch(
  computer: Computer,
  target: Target,
  request: BatchRequest,
  signal?: AbortSignal,
  deps: BatchDeps = {}
): Promise<BatchResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (request.timeoutMs ?? DEFAULT_BATCH_TIMEOUT_MS);
  const steps: ActionReceipt[] = [];
  const fillNotRun = (from: number): void => {
    for (let i = from; i < request.actions.length; i++) {
      steps[i] = { index: i, kind: request.actions[i]!.kind, status: "not_run" };
    }
  };

  for (let i = 0; i < request.actions.length; i++) {
    const action = request.actions[i]!;
    if (signal?.aborted) {
      fillNotRun(i);
      return { status: "interrupted", steps };
    }
    if (now() >= deadline) {
      steps[i] = {
        index: i,
        kind: action.kind,
        status: "not_run",
        error: { code: "batch_deadline", message: "batch timeout budget exhausted" }
      };
      fillNotRun(i + 1);
      return { status: "interrupted", steps };
    }
    const execution = await executeStep(computer, target, action, {
      deadlineAt: deadline,
      signal,
      index: i,
      sleep,
      now
    });
    steps[i] = execution.receipt;
    if (execution.receipt.status !== "delivered" &&
        execution.receipt.status !== "satisfied") {
      fillNotRun(i + 1);
      return { status: execution.status, steps };
    }
  }

  if (request.observe === undefined) return { status: "completed", steps };
  return completeFinalObservation(steps, {
    profile: "runtime",
    options: request.observe,
    deadlineAt: deadline,
    signal,
    observe: (options, context) => computer.observe(target, options, context),
  });
}
