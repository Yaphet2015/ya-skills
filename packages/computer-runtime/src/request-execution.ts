import type {
  ActionReceipt,
  BatchAction,
  BatchRequest,
  BatchResult,
  Observation,
  ObserveOptions
} from "./types.js";
import { ComputerError } from "./driver-result.js";
import type { StepExecutionResult } from "./step-execution.js";

export interface RequestFailure {
  code: string;
  message: string;
}

export interface RequestStepContext {
  index: number;
  action: BatchAction;
  deadlineAt: number;
  signal?: AbortSignal;
}

export interface RequestExecutionHooks {
  actionStarted?(index: number, kind: ActionReceipt["kind"]): Promise<void> | void;
  actionFinished?(receipt: ActionReceipt): Promise<void> | void;
}

interface FinalObservationPolicy {
  interruptCodes?: readonly string[];
  cancellationCode?: string;
  deadlineCode?: string;
}

export type RequestExecutionProfile = "standalone" | "hosted" | "script" | "script-single" | "runtime";

interface RequestExecutionPolicy {
  dispatchFailure: "throw" | "record_unknown";
  unknownErrorCode: string;
  boundaryErrors: "all" | "first" | "none";
  tailFailure: "reason" | "none";
  checkAfterAction: boolean;
  finalObservation?: FinalObservationPolicy;
}

const POLICIES: Record<RequestExecutionProfile, RequestExecutionPolicy> = {
  standalone: {
    dispatchFailure: "throw",
    unknownErrorCode: "action_failed",
    boundaryErrors: "first",
    tailFailure: "none",
    checkAfterAction: false
  },
  hosted: {
    dispatchFailure: "record_unknown",
    unknownErrorCode: "driver_worker_exited",
    boundaryErrors: "all",
    tailFailure: "reason",
    checkAfterAction: true,
    finalObservation: {
      interruptCodes: ["aborted", "request_cancelled"],
      cancellationCode: "request_cancelled",
      deadlineCode: "batch_deadline"
    }
  },
  script: {
    dispatchFailure: "record_unknown",
    unknownErrorCode: "action_failed",
    boundaryErrors: "all",
    tailFailure: "reason",
    checkAfterAction: true,
    finalObservation: {
      interruptCodes: [],
      cancellationCode: "request_cancelled",
      deadlineCode: "batch_deadline"
    }
  },
  "script-single": {
    dispatchFailure: "record_unknown",
    unknownErrorCode: "action_failed",
    boundaryErrors: "all",
    tailFailure: "reason",
    checkAfterAction: false
  },
  runtime: {
    dispatchFailure: "record_unknown",
    unknownErrorCode: "action_failed",
    boundaryErrors: "all",
    tailFailure: "reason",
    checkAfterAction: true,
    finalObservation: {
      interruptCodes: ["aborted", "request_cancelled"],
      cancellationCode: "request_cancelled",
      deadlineCode: "batch_deadline"
    }
  }
};

export interface RequestExecutionOptions extends RequestExecutionHooks {
  request: BatchRequest;
  deadlineAt: number;
  indexOffset?: number;
  boundary?: (stage: "before" | "after") => RequestFailure | null;
  beforeFinalObservation?: () => RequestFailure | null;
  dispatch(
    action: BatchAction,
    context: RequestStepContext
  ): Promise<StepExecutionResult>;
  observe?(
    options: ObserveOptions,
    context: { deadlineAt: number; signal?: AbortSignal }
  ): Promise<Observation>;
  acceptObservation?(observation: Observation): Promise<void> | void;
  signal?: AbortSignal;
  profile: RequestExecutionProfile;
}

function errorOf(error: unknown, fallbackCode = "action_failed"): RequestFailure {
  return {
    code: error instanceof ComputerError ? error.code : fallbackCode,
    message: error instanceof Error ? error.message : String(error)
  };
}

function failureForReceipt(receipt: ActionReceipt): RequestFailure {
  if (receipt.error !== undefined &&
      typeof receipt.error.code === "string" &&
      typeof receipt.error.message === "string") {
    return receipt.error;
  }
  if (receipt.status === "unknown") {
    return { code: "unknown_delivery", message: "the action had unknown delivery" };
  }
  return {
    code: "action_failed",
    message: "the action ended with " + receipt.status
  };
}

/** Shared serial request kernel for hosted, script, and standalone callers.
 *
 * The transport supplies one action dispatcher. This module owns the ordering
 * of boundary checks, durable start/finish hooks, receipts, not-run tails,
 * and the optional final observation. Storage and terminal request ownership
 * remain in the caller's request ledger.
 */
export async function executeRequest(
  options: RequestExecutionOptions
): Promise<BatchResult> {
  const policy = POLICIES[options.profile];
  const steps: ActionReceipt[] = [];
  const offset = options.indexOffset ?? 0;
  const record = async (receipt: ActionReceipt): Promise<void> => {
    steps.push(receipt);
    await options.actionFinished?.(receipt);
  };
  const recordNotRun = async (
    from: number,
    failure: RequestFailure | null
  ): Promise<void> => {
    for (let i = from; i < options.request.actions.length; i++) {
      const error =
        failure !== null &&
        (policy.boundaryErrors === "all" ||
          (policy.boundaryErrors === "first" && i === from))
          ? failure
          : undefined;
      await record({
        index: i + offset,
        kind: options.request.actions[i]!.kind,
        status: "not_run",
        ...(error !== undefined ? { error } : {})
      });
    }
  };
  const boundary = (stage: "before" | "after"): RequestFailure | null =>
    options.boundary?.(stage) ?? (
      Date.now() >= options.deadlineAt
        ? {
            code: "batch_deadline",
            message: stage === "before"
              ? "batch timeout budget exhausted before dispatch"
              : "batch timeout budget exhausted after the action"
          }
        : null
    );

  for (const [localIndex, action] of options.request.actions.entries()) {
    const index = localIndex + offset;
    const before = boundary("before");
    if (before !== null) {
      await recordNotRun(localIndex, before);
      return { status: "interrupted", steps };
    }
    await options.actionStarted?.(index, action.kind);
    const afterStart = boundary("before");
    if (afterStart !== null) {
      await recordNotRun(localIndex, afterStart);
      return { status: "interrupted", steps };
    }

    let dispatched: StepExecutionResult;
    try {
      dispatched = await options.dispatch(action, {
        index,
        action,
        deadlineAt: options.deadlineAt,
        signal: options.signal
      });
    } catch (error) {
      if (policy.dispatchFailure === "throw") throw error;
      const failure = errorOf(error, policy.unknownErrorCode);
      await record({
        index,
        kind: action.kind,
        status: "unknown",
        error: failure
      });
      await recordNotRun(localIndex + 1, {
        code: "not_run_after_unknown",
        message: "the preceding action had unknown delivery; remaining actions were not dispatched"
      });
      return { status: "interrupted", steps };
    }

    await record(dispatched.receipt);
    if (dispatched.receipt.status !== "delivered" &&
        dispatched.receipt.status !== "satisfied") {
      const interrupted =
        dispatched.receipt.status === "unknown" ||
        dispatched.status === "interrupted";
      const tailFailure = policy.tailFailure === "reason"
        ? failureForReceipt(dispatched.receipt)
        : null;
      await recordNotRun(localIndex + 1, tailFailure);
      return {
        status: interrupted ? "interrupted" : "failed",
        steps
      };
    }

    if (policy.checkAfterAction) {
      const after = boundary("after");
      if (after !== null) {
        await recordNotRun(localIndex + 1, after);
        return { status: "interrupted", steps };
      }
    }
  }

  if (options.request.observe !== undefined && options.observe !== undefined) {
    return completeFinalObservation(steps, {
      options: options.request.observe,
      deadlineAt: options.deadlineAt,
      signal: options.signal,
      before: options.beforeFinalObservation,
      observe: options.observe,
      acceptObservation: options.acceptObservation,
      profile: options.profile
    });
  }
  return { status: "completed", steps };
}

export interface FinalObservationOptions {
  profile: RequestExecutionProfile;
  options: ObserveOptions;
  deadlineAt: number;
  signal?: AbortSignal;
  before?: () => RequestFailure | null;
  observe(
    options: ObserveOptions,
    context: { deadlineAt: number; signal?: AbortSignal }
  ): Promise<Observation>;
  acceptObservation?(observation: Observation): Promise<void> | void;
}

/** Apply the common final-read policy without changing delivered receipts. */
export async function completeFinalObservation(
  steps: ActionReceipt[],
  options: FinalObservationOptions
): Promise<BatchResult> {
  const policy = POLICIES[options.profile].finalObservation;
  const before = options.before?.() ??
    (Date.now() >= options.deadlineAt
      ? {
          code: policy?.deadlineCode ?? "batch_deadline",
          message: "batch timeout budget exhausted before final observation"
        }
      : null);
  if (before !== null) {
    return { status: "interrupted", steps, observationError: before };
  }

  try {
    const observation = await options.observe(options.options, {
      deadlineAt: options.deadlineAt,
      signal: options.signal
    });
    if (options.signal?.aborted) {
      return {
        status: "interrupted",
        steps,
        observationError: {
          code: policy?.cancellationCode ?? "request_cancelled",
          message: "the batch was cancelled during final observation"
        }
      };
    }
    if (Date.now() >= options.deadlineAt) {
      return {
        status: "interrupted",
        steps,
        observationError: {
          code: policy?.deadlineCode ?? "batch_deadline",
          message: "batch timeout budget exhausted during final observation"
        }
      };
    }
    await options.acceptObservation?.(observation);
    return { status: "completed", steps, observation };
  } catch (error) {
    const code = error instanceof ComputerError ? error.code : undefined;
    const interrupted =
      options.signal?.aborted === true ||
      Date.now() >= options.deadlineAt ||
      (code !== undefined && policy?.interruptCodes?.includes(code) === true);
    return {
      status: interrupted ? "interrupted" : "completed",
      steps,
      observationError: {
        code: options.signal?.aborted
          ? policy?.cancellationCode ?? "request_cancelled"
          : Date.now() >= options.deadlineAt
            ? policy?.deadlineCode ?? "batch_deadline"
            : code ?? "final_observe_failed",
        message: options.signal?.aborted
          ? "the batch was cancelled during final observation"
          : Date.now() >= options.deadlineAt
            ? "batch timeout budget exhausted during final observation"
            : error instanceof Error ? error.message : String(error)
      }
    };
  }
}
