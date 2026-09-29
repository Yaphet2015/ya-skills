import type {
  ActionReceipt,
  ActionResult,
  BatchAction,
  Computer,
  Condition,
  Target
} from "./types.js";
import { ComputerError, parseActionResult } from "./driver-result.js";
import { evaluateCondition, isUnsupportedCondition } from "./conditions.js";
import { selectorMatches } from "./observe.js";

export interface StepExecutionOptions {
  deadlineAt: number;
  signal?: AbortSignal;
  index?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface StepExecutionResult {
  status: "completed" | "interrupted" | "failed";
  receipt: ActionReceipt;
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

function makeResult(
  index: number,
  action: BatchAction,
  status: StepExecutionResult["status"],
  receiptStatus: ActionReceipt["status"],
  error?: { code: string; message: string },
  result?: ActionResult | void
): StepExecutionResult {
  return {
    status,
    receipt: {
      index,
      kind: action.kind,
      status: receiptStatus,
      ...(error !== undefined ? { error } : {}),
      ...(result !== undefined ? { result } : {})
    }
  };
}

/** Execute exactly one already-validated action.
 *
 * This owns preconditions, local waits, native action delivery, and delivery
 * classification. Request sequencing, durable receipts, and final
 * observation stay in request-execution.ts.
 */
export async function executeStep(
  computer: Computer,
  target: Target,
  action: BatchAction,
  options: StepExecutionOptions
): Promise<StepExecutionResult> {
  const index = options.index ?? 0;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  if (options.signal?.aborted) {
    return makeResult(index, action, "interrupted", "not_run", {
      code: "request_cancelled",
      message: "the action was cancelled before dispatch"
    });
  }
  if (now() >= options.deadlineAt) {
    return makeResult(index, action, "interrupted", "not_run", {
      code: "batch_deadline",
      message: "batch timeout budget exhausted before dispatch"
    });
  }

  try {
    switch (action.kind) {
      case "click": {
        const selector = action.selector;
        const result = await computer.click(
          target,
          (element) => selectorMatches(selector, element),
          selector.match + " \"" + selector.text + "\"" + (selector.role ? " role=" + selector.role : "")
        );
        return makeResult(index, action, "completed", "delivered", undefined, result);
      }
      case "click_point":
        return makeResult(index, action, "completed", "delivered", undefined, await computer.clickPoint(target, action.point));
      case "set_value":
        return makeResult(index, action, "completed", "delivered", undefined,
          parseActionResult(await computer.setValue(target, action.elementToken, action.value)));
      case "type":
      case "key": {
        if (action.before !== undefined) {
          await assertBefore(
            computer,
            target,
            action.before,
            now,
            options.deadlineAt,
            sleep,
            options.signal
          );
        }
        if (now() >= options.deadlineAt) {
          return makeResult(index, action, "interrupted", "not_run", {
            code: "batch_deadline",
            message: "batch timeout budget exhausted before dispatch"
          });
        }
        const result = action.kind === "type"
          ? await computer.type(target, action.text, action.input)
          : await computer.key(target, action.key, action.modifiers, action.input);
        return makeResult(index, action, "completed", "delivered", undefined, result);
      }
      case "scroll":
        return makeResult(index, action, "completed", "delivered", undefined, await computer.scroll(target, action.spec));
      case "wait": {
        const satisfied = await waitForConditionLocally(
          computer,
          target,
          action.condition,
          action.timeoutMs,
          Math.min(options.deadlineAt - now(), Number.MAX_SAFE_INTEGER),
          now,
          sleep,
          options.signal
        );
        if (satisfied) return makeResult(index, action, "completed", "satisfied");
        return makeResult(index, action, "failed", "not_delivered", {
          code: "condition_timeout",
          message: "condition not met within " + action.timeoutMs + "ms"
        });
      }
    }
  } catch (error) {
    if (isUnsupportedCondition(error)) {
      return makeResult(index, action, "failed", "not_run", {
        code: "unsupported_condition",
        message: (error as Error).message
      });
    }
    const outcome = outcomeOf(error);
    const interrupted =
      options.signal?.aborted === true ||
      (error instanceof ComputerError &&
        (error.code === "aborted" ||
          error.code === "request_cancelled" ||
          error.code === "command_timeout"));
    return makeResult(
      index,
      action,
      interrupted || outcome === "unknown" ? "interrupted" : "failed",
      outcome,
      receiptError(error),
      error instanceof ComputerError ? error.result : undefined
    );
  }
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
  // A before assertion is a single bounded check (up to 3s), not a wait.
  const checkDeadline = Math.min(now() + 3_000, deadline);
  for (;;) {
    if (signal?.aborted) {
      throw new ComputerError("aborted", "the batch was cancelled", "not_delivered");
    }
    if (now() >= checkDeadline) {
      throw new ComputerError(
        "condition_not_met",
        "before-condition " + condition.kind + " not met before the step; observe and decide again",
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
        "before-condition " + condition.kind + " was observed after the step budget; observe and decide again",
        "not_delivered"
      );
    }
    if (evaluateCondition(condition, observation)) return;
    if (now() >= checkDeadline) {
      throw new ComputerError(
        "condition_not_met",
        "before-condition " + condition.kind + " not met before the step; observe and decide again",
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
  // focused_element always fails fast, never silently waits it out.
  evaluateCondition(condition, {
    ax: { status: "usable", elements: [], total: 0, returned: 0, complete: false },
    image: { status: "unavailable" },
    id: "check",
    target,
    capturedAt: 0,
    epoch: "",
    revision: 0,
    title: ""
  });
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
