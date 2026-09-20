import type { ActionReceipt, BatchAction, BatchRequest, BatchResult } from "./types.js";
import { executeRequest, type RequestStepContext } from "./request-execution.js";
import type { StepExecutionResult } from "./step-execution.js";

type Failure = { code: string; message: string };

export interface BatchSequence {
  /** Standalone commands retain their outer catch and omit tail errors. */
  mode: "standalone" | "hosted" | "script";
  deadlineAt: number;
  indexOffset?: number;
  boundary(stage: "before" | "after"): Failure | null;
  dispatch(action: BatchAction, context: RequestStepContext): Promise<StepExecutionResult>;
  started(index: number, kind: ActionReceipt["kind"]): Promise<void> | void;
  recorded(receipt: ActionReceipt): Promise<void>;
}

/** One durable action at a time. Observation and request lifetime belong to callers. */
export async function executeBatchSequence(
  request: BatchRequest,
  execution: BatchSequence
): Promise<Pick<BatchResult, "status" | "steps">> {
  const result = await executeRequest({
    request,
    deadlineAt: execution.deadlineAt,
    indexOffset: execution.indexOffset,
    boundary: execution.boundary,
    actionStarted: execution.started,
    actionFinished: execution.recorded,
    dispatch: execution.dispatch,
    profile: execution.mode
  });
  return result;
}
