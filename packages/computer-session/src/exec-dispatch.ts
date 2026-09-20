import {
  ComputerError,
  DEFAULT_BATCH_TIMEOUT_MS,
  validateBatch,
  executeRequest,
  type ActionReceipt,
  type BatchRequest,
  type Condition,
  type Observation
} from "@ya-skills/computer-runtime";
import { EXEC_MAX_OBSERVATIONS, type JsonValue, type ScriptRpcMethod } from "./exec-types.js";
import { callDriverStep } from "./host-driver.js";


export interface ExecDispatchDeps {
  /** Serial driver call dispatcher (host-owned). The runner supplies its
   * request-local signal so timeout/cancel closes native admission too. */
  driverCall(method: "observe" | "step" | "batch", args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  driverSupportsStep?: boolean;
  /** Durable journal hooks. The started hook is awaited before native
   * dispatch; the finished hook is awaited before the request can finish. */
  onActionStarted?(index: number, kind: ActionReceipt["kind"]): Promise<void> | void;
  onActionFinished?(
    index: number,
    kind: ActionReceipt["kind"],
    outcome: ActionReceipt["status"],
    error?: { code: string; message: string }
  ): Promise<void> | void;
}

/** Owns RPC receipts and evidence freshness for one execution. */
export function createExecDispatch(
  deps: ExecDispatchDeps,
  control: {
    runDeadlineAt: number;
    dispatchSignal: AbortSignal;
    requestAborted(): boolean;
    runAdmissionError(): ComputerError | null;
    markUnknownDelivery(): void;
    observationLimit(error: { code: string; message: string }): void;
  }
) {
  const { runDeadlineAt, dispatchSignal, requestAborted, runAdmissionError, markUnknownDelivery } = control;
  const receipts: ActionReceipt[] = [];
  const observations: Observation[] = [];
  let mutationsSinceObservation = 0;
  const registerObservation = (observation: Observation): void => {
    if (observations.length >= EXEC_MAX_OBSERVATIONS) {
      const error = {
        code: "observation_limit",
        message: `the script exceeded the limit of ${EXEC_MAX_OBSERVATIONS} returned observations — observe less or rely on state`
      };
      control.observationLimit(error);
      throw new ComputerError(error.code, error.message);
    }
    observations.push(observation);
    mutationsSinceObservation = 0;
  };
  const addReceipt = async (receipt: ActionReceipt): Promise<void> => {
    receipts.push(receipt);
    await deps.onActionFinished?.(receipt.index, receipt.kind, receipt.status, receipt.error);
    if (receipt.status === "delivered" || receipt.status === "satisfied") mutationsSinceObservation++;
    if (receipt.status === "unknown") markUnknownDelivery();
  };

  async function run(index: number, method: ScriptRpcMethod, rpcArgs: Record<string, JsonValue>): Promise<unknown> {
    if (method === "observe") {
      const beforeObserve = runAdmissionError();
      if (beforeObserve !== null) throw beforeObserve;
      const observation = (await deps.driverCall(
        "observe",
        {
          options: rpcArgs.options ?? { mode: "auto" },
          deadlineAt: runDeadlineAt
        },
        dispatchSignal
      )) as Observation;
      const afterObserve = runAdmissionError();
      if (afterObserve !== null) throw afterObserve;
      registerObservation(observation);
      return observation;
    }

    if (method === "batch") {
      const request = validateBatch(rpcArgs.request);
      const batchDeadlineAt = Math.min(runDeadlineAt, Date.now() + (request.timeoutMs ?? DEFAULT_BATCH_TIMEOUT_MS));
      return executeRequest({
        request,
        deadlineAt: batchDeadlineAt,
        indexOffset: index,
        boundary: (stage) => {
          const error = runAdmissionError();
          if (error) return { code: error.code, message: error.message };
          return Date.now() >= batchDeadlineAt ? {
            code: "batch_deadline",
            message: "the batch timeout budget expired " +
              (stage === "before" ? "before this action was dispatched" : "after this action")
          } : null;
        },
        beforeFinalObservation: () => {
          const error = runAdmissionError();
          if (error !== null) return { code: error.code, message: error.message };
          return Date.now() >= batchDeadlineAt
            ? { code: "batch_deadline", message: "the batch timeout budget expired before final observation" }
            : null;
        },
        dispatch: async (action, context) => {
          try {
            return await callDriverStep({ supportsStep: deps.driverSupportsStep, call: deps.driverCall }, action, { ...context, signal: dispatchSignal });
          } catch (error) {
            markUnknownDelivery();
            throw error;
          }
        },
        actionStarted: (actionIndex, kind) => deps.onActionStarted?.(actionIndex, kind),
        actionFinished: addReceipt,
        observe: (options, context) => deps.driverCall(
          "observe",
          { options, deadlineAt: context.deadlineAt },
          dispatchSignal
        ) as Promise<Observation>,
        acceptObservation: registerObservation,
        profile: "script"
      });
    }

    const kind = method as ActionReceipt["kind"];
    const beforeSingle = runAdmissionError();
    if (beforeSingle !== null) {
      await addReceipt({ index, kind, status: "not_run", error: { code: beforeSingle.code, message: beforeSingle.message } });
      throw beforeSingle;
    }
    await deps.onActionStarted?.(index, kind);
    let single: BatchRequest;
    try {
      single = validateBatch(singleActionBatch(method, rpcArgs));
    } catch (error) {
      const validationError = {
        code: "batch_request_invalid",
        message: error instanceof Error ? error.message : String(error)
      };
      await addReceipt({ index, kind, status: "not_delivered", error: validationError });
      throw new ComputerError(validationError.code, validationError.message, "not_delivered");
    }
    const afterValidation = runAdmissionError();
    if (afterValidation !== null) {
      await addReceipt({ index, kind, status: "not_run", error: { code: afterValidation.code, message: afterValidation.message } });
      throw afterValidation;
    }
    const singleResult = await executeRequest({
      request: single,
      deadlineAt: runDeadlineAt,
      indexOffset: index,
      boundary: () => {
        const error = runAdmissionError();
        return error === null ? null : { code: error.code, message: error.message };
      },
      dispatch: async (action, context) => {
        try {
          return await callDriverStep({ supportsStep: deps.driverSupportsStep, call: deps.driverCall }, action, { ...context, signal: dispatchSignal });
        } catch (error) {
          markUnknownDelivery();
          throw error;
        }
      },
      actionFinished: addReceipt,
      profile: "script-single"
    });
    const step = singleResult.steps[0];
    const status = step?.status ?? "unknown";
    if (status === "delivered" || status === "satisfied") {
      return method === "set_value" && status === "delivered"
        ? { route: "accessibility", effect: "confirmed" }
        : null;
    }
    throw new ComputerError(
      step?.error?.code ?? "action_failed",
      step?.error?.message ?? (method + " did not complete (" + status + ")"),
      status === "unknown" ? "unknown" : "not_delivered"
    );
  }

  return {
    run, receipts, observations, addReceipt, registerObservation,
    get needsObservation() { return observations.length === 0 || mutationsSinceObservation > 0; }
  };
}

function singleActionBatch(method: ScriptRpcMethod, args: Record<string, JsonValue>): BatchRequest {
  switch (method) {
    case "click":
      return { actions: [{ kind: "click", selector: args.selector as never }] };
    case "click_point":
      return { actions: [{ kind: "click_point", point: args.point as never }] };
    case "set_value":
      return { actions: [{ kind: "set_value", elementToken: String(args.elementToken ?? ""), value: String(args.value ?? "") }] };
    case "type":
      return {
        actions: [{
          kind: "type",
          text: String(args.text ?? ""),
          ...((args.before as Condition | undefined) !== undefined ? { before: args.before as Condition } : {})
        }]
      };
    case "key":
      return {
        actions: [{
          kind: "key",
          key: String(args.key ?? ""),
          ...(Array.isArray(args.modifiers) ? { modifiers: args.modifiers as string[] } : {}),
          ...((args.before as Condition | undefined) !== undefined ? { before: args.before as Condition } : {})
        }]
      };
    case "scroll":
      return { actions: [{ kind: "scroll", spec: args.spec as never }] };
    case "wait":
      return { actions: [{ kind: "wait", condition: args.condition as never, timeoutMs: Number(args.timeoutMs ?? 1_000) }] };
    default:
      throw new ComputerError("invalid_request", `${method} is not a single action`);
  }
}
