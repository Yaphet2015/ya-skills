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
  Observation,
  Selector,
  Target
} from "./types.js";
import { ComputerError } from "./session.js";
import { evaluateCondition, isUnsupportedCondition } from "./conditions.js";
import { selectorMatches } from "./observe.js";

export const DEFAULT_MAX_ACTIONS = 5;
export const MAX_ACTIONS_LIMIT = 20;
export const DEFAULT_BATCH_TIMEOUT_MS = 30_000;
export const MAX_BATCH_TIMEOUT_MS = 120_000;
const MAX_TEXT_LENGTH = 10_000;
const MAX_ELEMENT_TOKEN_LENGTH = 256;
const MAX_VALUE_LENGTH = 256 * 1024;
const MAX_ACTIONS_HARD_LIMIT = 500;

function fail(message: string): never {
  throw new Error(`${message}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validateSelector(value: unknown, where: string): Selector {
  if (!isObject(value)) fail(`${where} must be an object`);
  const text = (value as Record<string, unknown>).text;
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_TEXT_LENGTH) {
    fail(`${where}.text must be a non-empty string`);
  }
  const match = (value as Record<string, unknown>).match;
  if (match !== "exact" && match !== "contains") {
    fail(`${where}.match must be "exact" or "contains"`);
  }
  const role = (value as Record<string, unknown>).role;
  if (role !== undefined && (typeof role !== "string" || role.length === 0)) {
    fail(`${where}.role must be a non-empty string`);
  }
  return { text, match, ...(role !== undefined ? { role } : {}) };
}

function validateCondition(value: unknown, where: string): Condition {
  if (!isObject(value)) fail(`${where} must be an object`);
  const kind = (value as Record<string, unknown>).kind;
  if (kind === "element_exists") {
    return { kind, selector: validateSelector((value as Record<string, unknown>).selector, `${where}.selector`) };
  }
  if (kind === "element_value") {
    const v = (value as Record<string, unknown>).value;
    if (typeof v !== "string" || v.length > MAX_TEXT_LENGTH) {
      fail(`${where}.value must be a string`);
    }
    return { kind, selector: validateSelector((value as Record<string, unknown>).selector, `${where}.selector`), value: v };
  }
  if (kind === "window_exists") {
    return { kind };
  }
  if (kind === "focused_element") {
    // Structurally accepted (so validation errors are caught early) but the
    // evaluator rejects it at runtime with unsupported_condition.
    return { kind, selector: validateSelector((value as Record<string, unknown>).selector, `${where}.selector`) };
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
  const direction = (value as Record<string, unknown>).direction;
  if (direction !== "up" && direction !== "down" && direction !== "left" && direction !== "right") {
    fail(`${where}.direction must be up|down|left|right`);
  }
  const amount = validateFiniteNumber((value as Record<string, unknown>).amount, `${where}.amount`);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 100) {
    fail(`${where}.amount must be a positive integer <= 100`);
  }
  const x = validateFiniteNumber((value as Record<string, unknown>).x, `${where}.x`);
  const y = validateFiniteNumber((value as Record<string, unknown>).y, `${where}.y`);
  if (x < 0 || y < 0) fail(`${where}.x/.y must be non-negative`);
  return { direction, amount, x, y };
}

function validatePointClick(value: unknown, where: string): { observationId: string; x: number; y: number } {
  if (!isObject(value)) fail(`${where} must be an object`);
  const observationId = (value as Record<string, unknown>).observationId;
  if (typeof observationId !== "string" || !/^[0-9a-f-]{36}$/i.test(observationId)) {
    fail(`${where}.observationId must be a UUID (observe first)`);
  }
  const x = validateFiniteNumber((value as Record<string, unknown>).x, `${where}.x`);
  const y = validateFiniteNumber((value as Record<string, unknown>).y, `${where}.y`);
  if (x < 0 || y < 0) fail(`${where}.x/.y must be non-negative image pixel coordinates`);
  return { observationId, x, y };
}

function validateAction(value: unknown, index: number): BatchAction {
  const where = `actions[${index}]`;
  if (!isObject(value)) fail(`${where} must be an object`);
  const kind = (value as Record<string, unknown>).kind;
  const v = value as Record<string, unknown>;
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
  const rawActions = (value as Record<string, unknown>).actions;
  if (!Array.isArray(rawActions) || rawActions.length === 0) {
    fail("batch request needs a non-empty actions array");
  }
  const requestedMax = (value as Record<string, unknown>).maxActions;
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
  if (rawActions.length > MAX_ACTIONS_HARD_LIMIT) {
    fail(`batch exceeds the hard action limit of ${MAX_ACTIONS_HARD_LIMIT}`);
  }
  const timeoutMs = (value as Record<string, unknown>).timeoutMs;
  let parsedTimeout: number | undefined;
  if (timeoutMs !== undefined) {
    const t = validateFiniteNumber(timeoutMs, "timeoutMs");
    if (!Number.isSafeInteger(t) || t <= 0 || t > MAX_BATCH_TIMEOUT_MS) {
      fail(`timeoutMs must be a positive integer <= ${MAX_BATCH_TIMEOUT_MS}`);
    }
    parsedTimeout = t;
  }
  const observe = (value as Record<string, unknown>).observe;
  if (observe !== undefined) {
    if (!isObject(observe)) fail("observe must be an object");
    const mode = (observe as Record<string, unknown>).mode;
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

function receiptError(error: unknown): { code: string; message: string } {
  if (error instanceof ComputerError) {
    return { code: error.code, message: error.message };
  }
  return { code: "action_failed", message: error instanceof Error ? error.message : String(error) };
}

function outcomeOf(error: unknown): "delivered" | "not_delivered" | "unknown" {
  if (error instanceof ComputerError && error.actionOutcome !== undefined) return error.actionOutcome;
  return "not_delivered";
}

export interface BatchDeps {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Serial batch executor. All steps run in order on one target; the first
 * failing/unknown step stops the run and fills the rest as not_run. */
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
  const fillNotRun = (from: number) => {
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
    try {
      switch (action.kind) {
        case "click": {
          const selector = action.selector;
          await computer.click(
            target,
            (e) => selectorMatches(selector, e),
            `${selector.match} "${selector.text}"${selector.role ? ` role=${selector.role}` : ""}`
          );
          steps[i] = { index: i, kind: action.kind, status: "delivered" };
          break;
        }
        case "click_point": {
          await computer.clickPoint(target, action.point);
          steps[i] = { index: i, kind: action.kind, status: "delivered" };
          break;
        }
        case "set_value": {
          await computer.setValue(target, action.elementToken, action.value);
          steps[i] = { index: i, kind: action.kind, status: "delivered" };
          break;
        }
        case "type": {
          if (action.before !== undefined) {
            await assertBefore(computer, target, action.before, now, deadline, sleep, signal);
          }
          // Re-check the batch deadline AFTER the (possibly delayed)
          // before-condition and BEFORE dispatching input: a condition that
          // was satisfied late must not deliver input past the budget.
          if (now() >= deadline) {
            steps[i] = {
              index: i,
              kind: action.kind,
              status: "not_run",
              error: { code: "batch_deadline", message: "batch timeout budget exhausted before dispatch" }
            };
            fillNotRun(i + 1);
            return { status: "interrupted", steps };
          }
          await computer.type(target, action.text);
          steps[i] = { index: i, kind: action.kind, status: "delivered" };
          break;
        }
        case "key": {
          if (action.before !== undefined) {
            await assertBefore(computer, target, action.before, now, deadline, sleep, signal);
          }
          if (now() >= deadline) {
            steps[i] = {
              index: i,
              kind: action.kind,
              status: "not_run",
              error: { code: "batch_deadline", message: "batch timeout budget exhausted before dispatch" }
            };
            fillNotRun(i + 1);
            return { status: "interrupted", steps };
          }
          await computer.key(target, action.key, action.modifiers);
          steps[i] = { index: i, kind: action.kind, status: "delivered" };
          break;
        }
        case "scroll": {
          await computer.scroll(target, action.spec);
          steps[i] = { index: i, kind: action.kind, status: "delivered" };
          break;
        }
        case "wait": {
          const satisfied = await waitForConditionLocally(
            computer,
            target,
            action.condition,
            action.timeoutMs,
            Math.min(deadline - now(), Number.MAX_SAFE_INTEGER),
            now,
            sleep,
            signal
          );
          steps[i] = {
            index: i,
            kind: action.kind,
            status: satisfied ? "satisfied" : "not_delivered",
            ...(satisfied
              ? {}
              : { error: { code: "condition_timeout", message: `condition not met within ${action.timeoutMs}ms` } })
          };
          if (!satisfied) {
            fillNotRun(i + 1);
            return { status: "failed", steps };
          }
          break;
        }
        default: {
          const kind = (action as { kind?: string }).kind ?? "invalid";
          steps[i] = {
            index: i,
            kind: kind as BatchAction["kind"],
            status: "not_run",
            error: { code: "invalid_action", message: "unreachable" }
          };
          fillNotRun(i + 1);
          return { status: "failed", steps };
        }
      }
    } catch (error) {
      if (isUnsupportedCondition(error)) {
        steps[i] = { index: i, kind: action.kind, status: "not_run", error: { code: "unsupported_condition", message: (error as Error).message } };
        fillNotRun(i + 1);
        return { status: "failed", steps };
      }
      const outcome = outcomeOf(error);
      steps[i] = { index: i, kind: action.kind, status: outcome, error: receiptError(error) };
      fillNotRun(i + 1);
      // An unknown delivery (or a session-level abort/timeout) interrupts the
      // run; a known refusal fails it. Neither ever replays.
      const interrupted = signal?.aborted === true ||
        (error instanceof ComputerError && (error.code === "aborted" || error.code === "request_cancelled" || error.code === "command_timeout"));
      return { status: interrupted || outcome === "unknown" ? "interrupted" : "failed", steps };
    }
  }

  // Final observation: one read at the end, only if the driver is still
  // usable and the single absolute batch budget still has time. Its failure
  // keeps the receipts — it never rolls anything back; importantly, an
  // expired budget must not start a fresh per-observation timeout.
  if (request.observe !== undefined) {
    if (now() >= deadline) {
      return {
        status: "interrupted",
        steps,
        observationError: {
          code: "batch_deadline",
          message: "batch timeout budget exhausted before final observation"
        }
      };
    }
    try {
      const observation: Observation = await computer.observe(target, request.observe, {
        signal,
        deadlineAt: deadline
      });
      if (signal?.aborted) {
        return {
          status: "interrupted",
          steps,
          observationError: {
            code: "request_cancelled",
            message: "the batch was cancelled during final observation"
          }
        };
      }
      if (now() >= deadline) {
        return {
          status: "interrupted",
          steps,
          observationError: {
            code: "batch_deadline",
            message: "batch timeout budget exhausted during final observation"
          }
        };
      }
      return { status: "completed", steps, observation };
    } catch (error) {
      if (signal?.aborted || now() >= deadline ||
        (error instanceof ComputerError && (error.code === "aborted" || error.code === "request_cancelled"))) {
        return {
          status: "interrupted",
          steps,
          observationError: signal?.aborted
            ? { code: "request_cancelled", message: "the batch was cancelled during final observation" }
            : now() >= deadline
              ? { code: "batch_deadline", message: "batch timeout budget exhausted during final observation" }
              : receiptError(error)
        };
      }
      return {
        status: "completed",
        steps,
        observationError: receiptError(error)
      };
    }
  }
  return { status: "completed", steps };
}

async function assertBefore(
  computer: Computer,
  target: Target,
  condition: Condition,
  now: () => number,
  deadline: number,
  sleep: (ms: number) => Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  // A `before` assertion is a single bounded check (up to 3s), not a wait.
  const checkDeadline = Math.min(now() + 3_000, deadline);
  for (;;) {
    if (signal?.aborted) {
      throw new ComputerError("aborted", "the batch was cancelled", "not_delivered");
    }
    if (now() >= checkDeadline) {
      throw new ComputerError(
        "condition_not_met",
        `before-condition ${condition.kind} not met before the step; observe and decide again`,
        "not_delivered"
      );
    }
    const observation = await computer.observe(target, { mode: "ax" }, {
      signal,
      deadlineAt: checkDeadline
    });
    if (now() >= checkDeadline) {
      throw new ComputerError(
        "condition_not_met",
        `before-condition ${condition.kind} was observed after the step budget; observe and decide again`,
        "not_delivered"
      );
    }
    if (evaluateCondition(condition, observation)) return;
    if (now() >= checkDeadline) {
      throw new ComputerError(
        "condition_not_met",
        `before-condition ${condition.kind} not met before the step; observe and decide again`,
        "not_delivered"
      );
    }
    await sleep(200);
  }
}

async function waitForConditionLocally(
  computer: Computer,
  target: Target,
  condition: Condition,
  timeoutMs: number,
  remainingBatchMs: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
  signal?: AbortSignal
): Promise<boolean> {
  // focused_element always fails fast, never silently "waits it out".
  evaluateCondition(condition, { ax: { status: "usable", elements: [], total: 0, returned: 0, complete: false }, image: { status: "unavailable" }, id: "check", target, capturedAt: 0, epoch: "", revision: 0, title: "" });
  const budget = Math.max(0, Math.min(timeoutMs, remainingBatchMs));
  if (budget <= 0) return false;
  const deadline = now() + budget;
  for (;;) {
    if (signal?.aborted || now() >= deadline) return false;
    const observation = await computer.observe(target, { mode: "ax" }, {
      signal,
      deadlineAt: deadline
    });
    if (now() >= deadline) return false;
    if (evaluateCondition(condition, observation)) return true;
    if (now() >= deadline) return false;
    await sleep(Math.min(500, Math.max(deadline - now(), 1)));
  }
}
