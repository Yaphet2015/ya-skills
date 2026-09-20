import {
  DEFAULT_BATCH_TIMEOUT_MS,
  executeRequest,
  type BatchResult,
  type BatchRequest
} from "@ya-skills/computer-runtime";
import type { DriverHandle } from "./host-types.js";
import { callDriverStep } from "./host-driver.js";

type JournalEventType = "action_started" | "action_finished";
type JournalEventAppender = (
  requestId: string,
  type: JournalEventType,
  payload: Record<string, unknown>
) => Promise<void>;

export interface HostedBatchResult {
  status: "completed" | "interrupted" | "failed";
  steps: BatchResult["steps"];
  observation?: unknown;
  observationError?: { code: string; message: string };
}

/**
 * Run a validated batch across the persistent driver one action at a time.
 * The journal append is part of each action boundary, so a later action is
 * never sent before the previous outcome is durable.
 */
export async function executeHostedBatch(
  driver: Pick<DriverHandle, "call" | "supportsStep">,
  appendJournalEvent: JournalEventAppender,
  requestId: string,
  request: BatchRequest,
  signal: AbortSignal,
  absoluteDeadlineAt: number,
  finishedActions?: Set<number>
): Promise<HostedBatchResult> {
  const deadlineAt = Math.min(absoluteDeadlineAt, Date.now() + (request.timeoutMs ?? DEFAULT_BATCH_TIMEOUT_MS));
  return executeRequest({
    request,
    deadlineAt,
    signal,
    boundary: (stage) => actionBoundary(signal, deadlineAt, stage === "before" ? "before this action was dispatched" : "after this action"),
    dispatch: (action, context) => callDriverStep(driver, action, context),
    actionStarted: (index, kind) => appendJournalEvent(requestId, "action_started", { index, kind }),
    actionFinished: async (receipt) => {
      await appendJournalEvent(requestId, "action_finished", {
        index: receipt.index, kind: receipt.kind, outcome: receipt.status,
        ...(receipt.error !== undefined ? { error: receipt.error } : {})
      });
      finishedActions?.add(receipt.index);
    },
    observe: (options, context) => driver.call(
      "observe",
      { options, deadlineAt: context.deadlineAt },
      context.signal
    ) as Promise<never>,
    beforeFinalObservation: () => actionBoundary(signal, deadlineAt, "before final observation"),
    profile: "hosted"
  });
}

function actionBoundary(
  signal: AbortSignal,
  deadlineAt: number,
  suffix: string
): { code: string; message: string } | null {
  if (signal.aborted) return { code: "request_cancelled", message: `the batch was cancelled ${suffix}` };
  if (Date.now() >= deadlineAt) {
    return {
      code: "batch_deadline",
      message: suffix === "before this action was dispatched"
        ? "batch timeout budget exhausted before dispatch"
        : `batch timeout budget exhausted ${suffix}`
    };
  }
  return null;
}
