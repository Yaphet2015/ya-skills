// Host-side exec runner (C1/C2/C3): spawns the disposable exec worker, wires
// its fixed-method RPCs to the driver (strictly serially), enforces the
// action budget and wall-clock timeout, commits state after execution and
// cleanup are verified, and builds ExecResult from HOST-side observations — the script
// never self-reports success.
//
// Channel split (F16): fd3 is the CONTROL spool (RPC requests/replies,
// terminal events) with per-frame caps; stdout/stderr are LOGS captured into
// bounded host-side buffers. Output overflow closes admission and cancels
// the script immediately — it never silently continues.
//
// Request lifecycle (F3): a terminal state is only published after the
// script worker is stopped AND the in-flight native dispatch has settled (or
// is explicitly reported as still in flight, which closes the session as
// unusable). No request ever returns to idle with native work outstanding.

import { rm } from "node:fs/promises";
import { ComputerError, createExecutionScope, validateBatch, type ActionReceipt, type Observation } from "@ya-skills/computer-runtime";
import { stopProcessGroup, TERM_GRACE_MS } from "./process.js";
import { MAX_MESSAGE_BYTES } from "./protocol.js";
import {
  EXEC_DEFAULT_MAX_ACTIONS,
  EXEC_DEFAULT_TIMEOUT_MS,
  EXEC_MAX_ACTIONS_LIMIT,
  EXEC_MAX_CODE_BYTES,
  EXEC_MAX_OBSERVATIONS,
  EXEC_MAX_STATE_BYTES,
  EXEC_MAX_TIMEOUT_MS,
  SCRIPT_METHODS,
  type ExecOptions,
  type ExecResult,
  type JsonValue,
  type ScriptRpcMethod
} from "./exec-types.js";
import { commitExecState, execStateHash, loadExecState, validateJsonValue } from "./exec-state.js";
import { createExecDispatch, type ExecDispatchDeps } from "./exec-dispatch.js";
import { closeOwnedFd, launchExecWorker } from "./exec-launch.js";
import { createExecControlSpool, createExecOutputCapture } from "./exec-control.js";

/** Host-side cap on captured worker stdout/stderr (bytes each). */
const EXEC_WORKER_STDOUT_CAP = 64 * 1024;
/** Host-side cap on RPCs queued but not yet dispatched. */
const EXEC_RPC_QUEUE_LIMIT = 64;
/** Bounded wait for the in-flight native dispatch at request end (F3). */
const NATIVE_SETTLE_MS = 5_000;
/** Leave room for the session reply envelope around ExecResult. */
const EXEC_RESULT_MAX_BYTES = MAX_MESSAGE_BYTES - 4 * 1024;

function jsonBytes(value: unknown): number {
  const encoded = JSON.stringify(value, (_key, entry) => (typeof entry === "bigint" ? entry.toString() : entry));
  return Buffer.byteLength(encoded ?? "null", "utf8");
}

function boundedResult(result: ExecResult, requestId: string): ExecResult {
  const envelope = { schemaVersion: 1, requestId, status: result.status, result };
  if (jsonBytes(envelope) <= EXEC_RESULT_MAX_BYTES) return result;
  const dropped = result.observations.length + (result.observationsDropped ?? 0);
  const { workerOutput: _workerOutput, ...wireResult } = result as ExecResult & { workerOutput?: unknown };
  // Receipt status is lifecycle evidence, not optional presentation data. Keep
  // one compact receipt for every planned/dispatched action and never turn an
  // unknown or interrupted request into an ordinary failed request merely
  // because its observations exceeded the wire budget.
  const boundedReceipts: ActionReceipt[] = result.actions.map((receipt) => ({
    index: receipt.index,
    kind: receipt.kind,
    status: receipt.status,
    ...(receipt.error !== undefined
      ? {
          error: {
            code: receipt.error.code.slice(0, 128),
            message: receipt.error.message.slice(0, 512)
          }
        }
      : {})
  }));
  const lifecycleStatus: ExecResult["status"] =
    result.status === "unknown" ? "unknown" : result.status === "interrupted" ? "interrupted" : "failed";
  const bounded: ExecResult = {
    ...wireResult,
    status: lifecycleStatus,
    stateCommitted: false,
    value: null,
    actions: boundedReceipts,
    observations: [],
    logs: [],
    ...(dropped > 0 ? { observationsDropped: dropped } : {}),
    error: {
      code: lifecycleStatus === "unknown" ? result.error?.code ?? "unknown_delivery" : "result_limit",
      message: `the aggregate exec result exceeds the ${EXEC_RESULT_MAX_BYTES}-byte wire budget; ${boundedReceipts.length} receipt(s) were retained and ${dropped} observation(s) omitted`
    }
  };
  if (jsonBytes({ schemaVersion: 1, requestId, status: bounded.status, result: bounded }) <= EXEC_RESULT_MAX_BYTES) {
    return bounded;
  }
  // Action receipts are already bounded by the action budget, but keep the
  // final fallback explicit so user-controlled diagnostic fields can never
  // crowd the recovery evidence off the wire.
  return {
    ...bounded,
    actions: boundedReceipts,
    observationsDropped: dropped,
    error: {
      code: lifecycleStatus === "unknown" ? result.error?.code ?? "unknown_delivery" : "result_limit",
      message: "the aggregate exec result exceeded the wire budget; only bounded action receipts were retained"
    }
  };
}

export interface ExecDeps extends ExecDispatchDeps {
  sessionId: string;
  generation: string;
  target: { pid: number; windowId: bigint };
  stateDir: string;
  /** One auto-observation at the end when the script made none. Errors
   * PROPAGATE (F14): the runner records final_observe_failed. */
  finalObserve(signal?: AbortSignal, deadlineAt?: number): Promise<Observation | null>;
  /** Live-worker tracking for lease ownership + diagnostics (F2/F23). */
  onExecWorkerSpawn?(pid: number | null): Promise<void> | void;
  onExecWorkerExit?(pid: number | null): Promise<void> | void;
  /** Persist an unresolved process-group identity before the host can die. */
  onExecWorkerCleanupFailed?(pid: number | null, pgid: number | null): Promise<void> | void;
  /** Durable journal intent written before the host commits state. */
  onStateCommitIntent?(intent: { expectedVersion: number; version: number; hash: string }): Promise<void> | void;
  /** Hosted executions commit the terminal result and state together. Direct
   * callers retain the legacy state-file writer. This callback is synchronous
   * so no cancellation can interleave with the final commit decision. */
  commitState?(expectedVersion: number, state: Record<string, JsonValue>, result: ExecResult): { version: number; hash: string };
  /** Absolute request deadline, including setup and journal callbacks. */
  deadlineAt?: number;
}

export function normalizeExecOptions(operation: { code: unknown; sourceName: unknown; timeoutMs: unknown; maxActions: unknown }): ExecOptions {
  if (typeof operation.code !== "string" || operation.code.length === 0) {
    throw new ComputerError("invalid_code", "exec code must be a non-empty string");
  }
  if (Buffer.byteLength(operation.code, "utf8") > EXEC_MAX_CODE_BYTES) {
    throw new ComputerError("code_too_large", `code exceeds ${EXEC_MAX_CODE_BYTES} bytes`);
  }
  const timeoutMs = operation.timeoutMs === undefined ? EXEC_DEFAULT_TIMEOUT_MS : Number(operation.timeoutMs);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > EXEC_MAX_TIMEOUT_MS) {
    throw new ComputerError("invalid_timeout", `timeoutMs must be a safe integer <= ${EXEC_MAX_TIMEOUT_MS}`);
  }
  const maxActions = operation.maxActions === undefined ? EXEC_DEFAULT_MAX_ACTIONS : Number(operation.maxActions);
  if (!Number.isSafeInteger(maxActions) || maxActions <= 0 || maxActions > EXEC_MAX_ACTIONS_LIMIT) {
    throw new ComputerError("invalid_budget", `maxActions must be a safe integer <= ${EXEC_MAX_ACTIONS_LIMIT}`);
  }
  return {
    code: operation.code,
    sourceName: typeof operation.sourceName === "string" ? operation.sourceName : "script.js",
    timeoutMs,
    maxActions
  };
}

export async function runExec(
  deps: ExecDeps,
  requestId: string,
  options: ExecOptions,
  signal?: AbortSignal
): Promise<ExecResult> {
  const runStartedAt = Date.now();
  const stateBefore = loadExecState(deps.stateDir);
  const runDeadlineAt = deps.deadlineAt ?? runStartedAt + options.timeoutMs;
  const execution = createExecutionScope({ deadlineAt: runDeadlineAt, signal });
  const dispatchAbort = execution.child();
  try {
    let logs: string[] = [];
    let actionCount = 0;
    let admissionClosed = false;
    const uncommitted = () => ({
      stateVersion: stateBefore.version,
      stateCommitted: false,
      actions: receipts,
      observations,
      logs
    });
    /** Run-level unknown delivery (F6): no state commit, terminal unknown. */
    let runUnknownDelivery = false;
    /** Hard resource boundaries are terminal even if user code catches the
     * rejected facade promise; they must not later commit state as success. */
    let runLimitError: { code: string; message: string } | null = null;
    const markUnknownDelivery = (): void => {
      runUnknownDelivery = true;
      admissionClosed = true;
      dispatchAbort.abort();
    };
    const cancellationRequested = (): boolean => signal?.aborted === true || (runLimitError !== null && runLimitError.code === "request_cancelled");
    const executionTimedOut = (): boolean => runLimitError !== null && runLimitError.code === "execution_timeout";

    const dispatch = createExecDispatch(deps, {
      runDeadlineAt,
      dispatchSignal: dispatchAbort.signal,
      requestAborted: () => signal?.aborted === true,
      runAdmissionError: () => admissionError(),
      markUnknownDelivery,
      observationLimit: (error) => { runLimitError = error; admissionClosed = true; }
    });
    const { receipts, observations, addReceipt, registerObservation } = dispatch;

    if (runDeadlineAt <= Date.now() || signal?.aborted) {
      return {
        status: signal?.aborted ? "interrupted" : "failed",
        ...uncommitted(),
        error: {
          code: signal?.aborted ? "request_cancelled" : "execution_timeout",
          message: signal?.aborted ? "the exec request was cancelled before worker start" : "the execution budget expired before worker start"
        }
      };
    }

    const { child, configDir, controlPath, controlReadFd } = await launchExecWorker({
      sessionId: deps.sessionId,
      generation: deps.generation,
      requestId,
      target: deps.target,
      state: stateBefore,
      options,
      onSpawn: (pid) => deps.onExecWorkerSpawn?.(pid)
    });

    let settled = false;
    const terminal: { result?: ExecResult } = {};
    /** The native dispatch currently in flight (F3): a terminal reply waits
     * for it (bounded) instead of leaving native work behind an idle session. */
    let inFlightNative: Promise<unknown> | null = null;
    let queuedDispatches = 0;
    let pendingCommit: { state: Record<string, JsonValue> } | null = null;
    let workerCleanupFailed = false;
    let nativeDispatchUnresolved = false;

    const finish = (result: ExecResult) => {
      if (settled) return;
      // A terminal worker frame closes dispatch admission. RPC frames that
      // were already queued are reduced below as not_run unless their run has
      // already crossed the native dispatch boundary.
      admissionClosed = true;
      settled = true;
      terminal.result = result;
    };

    const admissionError = (): ComputerError | null => {
      if (runUnknownDelivery) {
        return new ComputerError("unknown_delivery", "the request has unknown native delivery", "unknown");
      }
      if (signal?.aborted) {
        return new ComputerError("request_cancelled", "the exec request was cancelled", "not_delivered");
      }
      if (Date.now() >= runDeadlineAt) {
        const error = new ComputerError("execution_timeout", "the execution budget expired before the next dispatch", "not_delivered");
        runLimitError ??= { code: error.code, message: error.message };
        admissionClosed = true;
        dispatchAbort.abort();
        return error;
      }
      if (settled || admissionClosed) {
        return new ComputerError("exec_finished", "the exec request is no longer accepting RPCs");
      }
      return null;
    };

    // Driver-side dispatch: one RPC at a time, host-generated receipts. The
    // chain SERIALIZES the actual driver calls — two facade actions can never
    // be in the driver at once (F3).
    let dispatchChain: Promise<unknown> = Promise.resolve();
    const dispatchRpc = (method: ScriptRpcMethod, rpcArgs: Record<string, JsonValue>): Promise<JsonValue> => {
      const earlyError = admissionError();
      if (earlyError !== null) return Promise.reject(earlyError);
      if (queuedDispatches >= EXEC_RPC_QUEUE_LIMIT) {
        return Promise.reject(new ComputerError("rpc_queue_overflow", `more than ${EXEC_RPC_QUEUE_LIMIT} facade calls are queued — await them or reduce fan-out`));
      }
      if (!SCRIPT_METHODS.includes(method)) {
        const error = new ComputerError("invalid_rpc", `unknown facade method: ${String(method)}`);
        runLimitError = { code: error.code, message: error.message };
        admissionClosed = true;
        return Promise.reject(error);
      }
      const requestedCost =
        method === "batch" && typeof rpcArgs.request === "object" && rpcArgs.request !== null &&
        Array.isArray((rpcArgs.request as { actions?: unknown[] }).actions)
          ? Math.max(1, (rpcArgs.request as { actions: unknown[] }).actions.length)
          : 1;
      if (actionCount + requestedCost > options.maxActions) {
        const error = new ComputerError("action_budget_exceeded", `the script exceeded its budget of ${options.maxActions} facade actions`);
        runLimitError = { code: error.code, message: error.message };
        admissionClosed = true;
        return Promise.reject(error);
      }
      const index = actionCount;
      actionCount += requestedCost;
      queuedDispatches++;
      const run = async (): Promise<JsonValue> => {
        let nativeCall: Promise<unknown> = Promise.resolve();
        try {
          const beforeRunError = admissionError();
          if (beforeRunError !== null) {
            // The worker may emit exec_unawaited immediately after an RPC
            // frame; the host can therefore reject a queued call before its
            // first step starts. Preserve a receipt for every such call.
            if (!receipts.some((receipt) => receipt.index === index)) {
              if (method === "batch") {
                try {
                  const request = validateBatch(rpcArgs.request);
                  for (const [offset, action] of request.actions.entries()) {
                    await addReceipt({
                      index: index + offset, kind: action.kind, status: "not_run",
                      error: { code: beforeRunError.code, message: beforeRunError.message }
                    });
                  }
                } catch {
                  // Structural validation errors are already represented by
                  // the worker/host terminal failure; no desktop input crossed
                  // here.
                }
              } else if (method !== "observe") {
                await addReceipt({
                  index,
                  kind: method,
                  status: "not_run",
                  error: { code: beforeRunError.code, message: beforeRunError.message }
                });
              }
            }
            throw beforeRunError;
          }
          nativeCall = dispatch.run(index, method, rpcArgs);
          inFlightNative = nativeCall;
          return (await nativeCall) as JsonValue;
        } catch (error) {
          if (
            !(error instanceof ComputerError) &&
            method !== "observe" &&
            method !== "batch" &&
            !receipts.some((receipt) => receipt.index === index)
          ) {
            receipts.push({
              index,
              kind: method,
              status: "unknown",
              error: { code: "action_failed", message: error instanceof Error ? error.message : String(error) }
            });
          }
          if (error instanceof ComputerError && error.actionOutcome === "unknown") {
            markUnknownDelivery();
          }
          if (error instanceof ComputerError && (error.code === "journal_error" || error.code === "event_persist_failed")) {
            runLimitError = { code: error.code, message: error.message };
            admissionClosed = true;
          }
          throw error;
        } finally {
          queuedDispatches--;
          if (inFlightNative === nativeCall) inFlightNative = null;
        }
      };
      const next = dispatchChain.then(run, run);
      dispatchChain = next.catch(() => undefined);
      return next;
    };

    const handleWorkerLine = (line: string): void => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      switch (message.type) {
        case "exec_started":
          return;
        case "rpc": {
          const seq = Number(message.seq);
          if (!Number.isSafeInteger(seq) || seq <= 0 || !SCRIPT_METHODS.includes(message.method as ScriptRpcMethod)) {
            admissionClosed = true;
            runLimitError = { code: "invalid_rpc", message: "exec worker sent an invalid RPC envelope" };
            writeRpc({
              seq: Number.isSafeInteger(seq) ? seq : 0,
              ok: false,
              error: { code: "invalid_rpc", message: "invalid RPC sequence or method" }
            });
            return;
          }
          const method = message.method as ScriptRpcMethod;
          void dispatchRpc(method, (message.args as Record<string, JsonValue>) ?? {})
            .then((result) => writeRpc({ seq, ok: true, result }))
            .catch((error: unknown) =>
              writeRpc({
                seq,
                ok: false,
                error: {
                  code: error instanceof ComputerError ? error.code : "rpc_failed",
                  message: error instanceof Error ? error.message : String(error)
                }
              })
            );
          return;
        }
        case "exec_done": {
          // A terminal frame received after an earlier terminal outcome is a
          // late transport artifact. It must not create a pending state commit
          // after the host has already classified the request as failed.
          if (settled) return;
          const value = message.value as unknown;
          const candidateState = message.state as unknown;
          logs = (message.logs as string[]) ?? [];
          if (runUnknownDelivery) {
            // An unknown native delivery happened during the run: completion
            // cannot be claimed and state is NEVER committed (F6).
            finish({
              status: "unknown",
              ...uncommitted(),
              error: {
                code: "unknown_delivery",
                message: "at least one facade action ended with unknown delivery — state was not committed; observe instead of replaying"
              }
            });
            return;
          }
          if (runLimitError && runLimitError.code !== "execution_timeout") {
            finish({
              status: runLimitError.code === "request_cancelled" ? "interrupted" : "failed",
              ...uncommitted(),
              error: runLimitError
            });
            return;
          }
          try {
            if (typeof candidateState !== "object" || candidateState === null || Array.isArray(candidateState)) {
              throw new Error("exec state must be a plain JSON object");
            }
            const validatedState = validateJsonValue(candidateState, EXEC_MAX_STATE_BYTES) as Record<string, JsonValue>;
            const validatedValue = validateJsonValue(value ?? null, EXEC_MAX_STATE_BYTES);
            const candidate: ExecResult = {
              status: "completed",
              value: validatedValue,
              ...uncommitted()
            };
            const bounded = boundedResult(candidate, requestId);
            if (bounded !== candidate || bounded.error?.code === "result_limit") {
              finish(bounded);
            } else {
              // State commitment is finalized after worker/group cleanup and the
              // required final observation. This lets the host reject an
              // oversized aggregate before committing, while a final-read
              // failure still commits the already-valid script state factually.
              pendingCommit = { state: validatedState };
              finish(candidate);
            }
          } catch (error) {
            finish({
              status: "failed",
              ...uncommitted(),
              error: {
                code: error instanceof ComputerError ? error.code : "state_invalid",
                message: error instanceof Error ? error.message : String(error)
              }
            });
          }
          return;
        }
        case "exec_failed": {
          if (settled) return;
          const error = message.error as { code: string; message: string };
          logs = (message.logs as string[]) ?? [];
          finish({
            status: runUnknownDelivery ? "unknown" : runLimitError?.code === "request_cancelled" || signal?.aborted ? "interrupted" : "failed",
            ...uncommitted(),
            error
          });
          return;
        }
        case "exec_unawaited": {
          if (settled) return;
          logs = (message.logs as string[]) ?? [];
          finish({
            status: runUnknownDelivery ? "unknown" : runLimitError?.code === "request_cancelled" || signal?.aborted ? "interrupted" : "failed",
            ...uncommitted(),
            error: {
              code: "unawaited_actions",
              message: `the script returned with ${JSON.stringify(message.pendingSeqs)} facade call(s) still in flight; their results are recorded but completion is not claimed`
            }
          });
          return;
        }
        default:
          return;
      }
    };

    const writeRpc = (reply: unknown): void => {
      try {
        // Control replies ride the worker's stdin; observations carry
        // decimal-string windowIds (the same wire convention as the socket).
        child.stdin!.write(
          `${JSON.stringify(reply, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}\n`
        );
      } catch {
        // worker gone; its RPCs will fail via exit handling
      }
    };

    const control = createExecControlSpool(
      controlPath,
      controlReadFd,
      handleWorkerLine,
      () => {
        admissionClosed = true;
        void stopProcessGroup(child, TERM_GRACE_MS);
      }
    );
    const pollControl = (): void => control.poll();

    const controlTimer = setInterval(pollControl, 10);
    controlTimer.unref();

    // stdout/stderr are LOGS: bounded host-side capture; overflow closes
    // admission and reclaims the worker immediately.
    const outputCapture = createExecOutputCapture(EXEC_WORKER_STDOUT_CAP);
    outputCapture.attach(
      child,
      () => {
        admissionClosed = true;
        finish({
          status: runUnknownDelivery ? "unknown" : "interrupted",
          ...uncommitted(),
          error: {
            code: "output_limit",
            message: `the script's combined stdout/stderr exceeded ${EXEC_WORKER_STDOUT_CAP} bytes — execution cancelled at the limit`
          }
        });
        void stopProcessGroup(child, TERM_GRACE_MS);
      },
      (kind) => {
        admissionClosed = true;
        finish({
          status: "failed",
          ...uncommitted(),
          error: { code: "protocol_utf8", message: `${kind} log output is not valid UTF-8` }
        });
        void stopProcessGroup(child, TERM_GRACE_MS);
      }
    );

    child.on("exit", (code, signal) => {
      // A short script can write exec_done and exit before the first interval
      // tick. Drain its regular-file control stream to a verified EOF before
      // treating the exit as a missing terminal frame.
      control.drainToEof();
      if (!settled) {
        finish({
          status: runUnknownDelivery ? "unknown" : code === 0 || signal === "SIGTERM" ? "interrupted" : "failed",
          ...uncommitted(),
          error: {
            code: signal === "SIGTERM" ? "execution_timeout" : "worker_exit",
            message: `the exec worker exited (code=${code} signal=${signal ?? null})`
          }
        });
      }
    });
    child.on("error", (error) => {
      if (!settled) {
        finish({
          status: "failed",
          ...uncommitted(),
          error: { code: "worker_spawn_failed", message: error.message }
        });
      }
    });

    // Cancel/timeout (F3): close admission synchronously, reclaim the script
    // worker group, then wait for the in-flight native dispatch to settle
    // (bounded) BEFORE publishing the terminal state.
    const stopWorker = (reason: string, code: string): void => {
      admissionClosed = true;
      dispatchAbort.abort();
      if (!settled && (code === "execution_timeout" || code === "request_cancelled")) {
        runLimitError ??= { code, message: reason };
      }
      void (async () => {
        const stop = await stopProcessGroup(child, TERM_GRACE_MS);
        if (!settled) {
          finish({
            status: runUnknownDelivery ? "unknown" : "interrupted",
            ...uncommitted(),
            error: {
              code,
              message:
                stop.exited
                  ? `${reason} (worker group reclaimed${stop.groupSurvivors !== null ? "" : " cleanly"})`
                  : `${reason} and the worker group could NOT be reclaimed (survivors: pgid ${stop.groupSurvivors})`
            }
          });
        }
      })();
    };
    const onAbort = () => stopWorker("the exec request was cancelled", "request_cancelled");
    if (execution.signal.aborted) onAbort();
    else execution.signal.addEventListener("abort", onAbort, { once: true });
    execution.onDeadline(() => stopWorker(`the script exceeded ${options.timeoutMs}ms`, "execution_timeout"));

    try {
      const deadline = runDeadlineAt + TERM_GRACE_MS + NATIVE_SETTLE_MS;
      while (!settled && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!settled) {
        finish({
          status: "unknown",
          ...uncommitted(),
          error: { code: "execution_timeout", message: "exec result never settled" }
        });
      }
    } finally {
      // Keep already queued RPCs reducible while the worker's terminal frame
      // and any same-poll rpc frames are being reduced. Admission is closed by
      // the terminal frame, so queued calls become not_run unless they already
      // crossed the native dispatch boundary.
      // ALWAYS reclaim the group, including after successful completion (F4):
      // a script's surviving descendants are ordinary cleanup, not success.
      const stop = await stopProcessGroup(child, TERM_GRACE_MS);
      if (stop.exited) {
        // Ownership is removed only after the whole process group is proven
        // gone. A leader exit is not enough; failed cleanup keeps the worker pid
        // in the lease and makes the session unusable.
        try {
          await deps.onExecWorkerExit?.(child.pid ?? null);
        } catch (error) {
          workerCleanupFailed = true;
          if (terminal.result) {
            terminal.result.status = "unknown";
            terminal.result.error = {
              code: "worker_cleanup_failed",
              message: error instanceof Error ? error.message : String(error)
            };
          }
        }
      } else {
        workerCleanupFailed = true;
        try {
          await deps.onExecWorkerCleanupFailed?.(child.pid ?? null, stop.groupSurvivors);
        } catch (error) {
          // A failed lease refresh is itself an unresolved cleanup proof; keep
          // the host unusable rather than dropping the survivor identity.
          if (terminal.result) {
            terminal.result.error = {
              code: "worker_cleanup_failed",
              message: error instanceof Error ? error.message : String(error)
            };
          }
        }
        if (terminal.result) {
          terminal.result.status = "unknown";
          terminal.result.error = {
            code: "worker_group_unclean",
            message: `the script ended but its process group could not be fully reclaimed (survivors: pgid ${stop.groupSurvivors})`
          };
        }
      }
      // Settle queued and in-flight native dispatches (F3): regular-file
      // control polling can observe an rpc frame at the same time as the worker
      // exit, so the dispatch may not have assigned inFlightNative yet. Wait for
      // both counters before publishing the terminal state.
      if (queuedDispatches > 0 || inFlightNative !== null) {
        const settleDeadline = Date.now() + NATIVE_SETTLE_MS;
        while ((queuedDispatches > 0 || inFlightNative !== null) && Date.now() < settleDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if ((queuedDispatches > 0 || inFlightNative !== null) && terminal.result) {
          nativeDispatchUnresolved = true;
          dispatchAbort.abort();
          terminal.result.status = "unknown";
          terminal.result.error = {
            code: "native_in_flight",
            message: "a native dispatch was still executing when the request ended — delivery state is unknown; the session must not reuse the driver"
          };
        }
      }
      admissionClosed = true;
      clearInterval(controlTimer);
      // The worker may have flushed its final control frame just before group
      // cleanup. The process group is now proven gone, so drain all remaining
      // chunks before closing and deleting the spool.
      control.drainToEof();
      closeOwnedFd(controlReadFd);
      await rm(configDir, { recursive: true, force: true }).catch(() => undefined);
    }

    let result = terminal.result!;
    const rejectCommit = (status: ExecResult["status"], error: NonNullable<ExecResult["error"]>): void => {
      Object.assign(result, { status, stateCommitted: false, error });
      pendingCommit = null;
    };
    // Attach captured worker stdout/stderr overflow diagnostics when present.
    if (outputCapture.stdout.length > 0 || outputCapture.stderr.length > 0) {
      (result as ExecResult & { workerOutput?: { stdout?: string; stderr?: string } }).workerOutput = {
        ...(outputCapture.stdout.length > 0 ? { stdout: outputCapture.stdout.join("").slice(-16 * 1024) } : {}),
        ...(outputCapture.stderr.length > 0 ? { stderr: outputCapture.stderr.join("").slice(-16 * 1024) } : {})
      };
    }
    // Final observation (F14): append a fresh observation when the script never
    // observed, OR when mutations happened after its last observation. A prior
    // observation is reused ONLY when nothing mutated since (no stale reuse).
    if (result.status === "completed" && dispatch.needsObservation) {
      if (cancellationRequested()) {
        rejectCommit("interrupted", { code: "request_cancelled", message: "the exec request was cancelled before final observation/commit" });
      } else if (executionTimedOut()) {
        result.status = "failed";
        result.stateCommitted = false;
        // The script state is a factual local result even when the final read
        // could not begin before the wall-clock budget. Preserve it for the
        // post-timeout commit path; no further desktop input is attempted.
        result.error = { code: "final_observe_failed", message: "the execution budget expired before the final observation" };
      } else if (observations.length >= EXEC_MAX_OBSERVATIONS) {
        rejectCommit("failed", {
          code: "observation_limit",
          message: `the required final observation would exceed the limit of ${EXEC_MAX_OBSERVATIONS}; no fresh evidence was silently dropped`
        });
      } else {
        const remaining = runDeadlineAt - Date.now();
        if (remaining <= 0) {
          result.status = "failed";
          result.error = { code: "final_observe_failed", message: "the execution budget expired before the final observation" };
        } else {
          // Track the final read just like every other native dispatch. A timed
          // out final read cannot be left behind an apparently idle session.
          const finalNative = Promise.resolve().then(() => deps.finalObserve(dispatchAbort.signal, runDeadlineAt));
          let finalSettled = false;
          void finalNative.then(
            () => { finalSettled = true; },
            () => { finalSettled = true; }
          );
          inFlightNative = finalNative;
          let finalTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            const timer = new Promise<never>((_, reject) => {
              finalTimer = setTimeout(() => reject(new ComputerError("command_timeout", "final observation timed out")), remaining);
            });
            const final = await Promise.race([finalNative, timer]);
            if (!final) {
              throw new ComputerError("final_observe_failed", "the driver returned no final observation");
            }
            if (cancellationRequested() || dispatchAbort.signal.aborted || Date.now() >= runDeadlineAt) {
              const cancelled = cancellationRequested();
              rejectCommit(cancelled ? "interrupted" : "failed", cancelled
                ? { code: "request_cancelled", message: "the exec request was cancelled during final observation" }
                : { code: "final_observe_failed", message: "the execution budget expired during final observation" });
            } else {
              registerObservation(final);
            }
          } catch (error) {
            if (cancellationRequested()) {
              rejectCommit("interrupted", { code: "request_cancelled", message: "the exec request was cancelled during final observation" });
            } else if (error instanceof ComputerError && error.code === "observation_limit") {
              rejectCommit("failed", { code: error.code, message: error.message });
            } else {
              result.status = "failed";
              result.error = {
                code: "final_observe_failed",
                message: error instanceof Error ? error.message : String(error)
              };
            }
          } finally {
            if (finalTimer !== undefined) clearTimeout(finalTimer);
            if (!finalSettled) {
              const settleDeadline = Date.now() + NATIVE_SETTLE_MS;
              while (!finalSettled && Date.now() < settleDeadline) {
                await new Promise((resolve) => setTimeout(resolve, 50));
              }
              if (!finalSettled) {
                nativeDispatchUnresolved = true;
                rejectCommit("unknown", {
                  code: "native_in_flight",
                  message: "the final observation was still executing when the request ended — delivery state is unknown"
                });
              }
            }
            if (finalSettled && inFlightNative === finalNative) inFlightNative = null;
          }
        }
      }
    }

    // Late transport failures can arrive after the worker has already emitted a
    // terminal event (for example an unawaited facade call). Reconcile the
    // result after every native settle window; never return the stale success.
    if (runUnknownDelivery || nativeDispatchUnresolved || workerCleanupFailed) {
      rejectCommit("unknown", {
        code: "unknown_delivery",
        message: "native delivery or worker cleanup was not proven; state was not committed"
      });
    } else if (cancellationRequested()) {
      rejectCommit("interrupted", { code: "request_cancelled", message: "the exec request was cancelled; state was not committed" });
    } else if (result.status === "completed" && Date.now() >= runDeadlineAt) {
      rejectCommit("failed", { code: "execution_timeout", message: "the execution budget expired before state commit" });
    }

    // Enforce the aggregate terminal-result budget BEFORE committing state. On
    // overflow, retain bounded action receipts and an explicit omission count;
    // never send an oversized frame that the client cannot recover.
    const bounded = boundedResult(result, requestId);
    if (bounded !== result) {
      result = bounded;
      pendingCommit = null;
    }

    // Commit only after final evidence and the aggregate-size check. A final
    // observation failure does not rewrite the factual state-commit flag: the
    // script was valid and its state can still be recovered independently.
    if (pendingCommit !== null && !runUnknownDelivery && !nativeDispatchUnresolved && !workerCleanupFailed) {
      const candidateState = pendingCommit.state;
      const hash = execStateHash(candidateState);
      const commitBlocked = (phase: "before" | "during"): boolean => {
        const finalReadFailed = result.error?.code === "final_observe_failed";
        if (!signal?.aborted && (finalReadFailed || (!dispatchAbort.signal.aborted && Date.now() < runDeadlineAt))) return false;
        rejectCommit(signal?.aborted ? "interrupted" : "failed", signal?.aborted
          ? { code: "request_cancelled", message: `the exec request was cancelled ${phase} state commit` }
          : { code: "execution_timeout", message: `the execution budget expired ${phase} state commit` });
        return true;
      };
      if (!commitBlocked("before")) {
        try {
          await deps.onStateCommitIntent?.({
            expectedVersion: stateBefore.version,
            version: stateBefore.version + 1,
            hash
          });
          if (!commitBlocked("during")) {
            const committed = deps.commitState?.(stateBefore.version, candidateState, result);
            result.stateVersion = committed?.version ?? commitExecState(deps.stateDir, stateBefore.version, candidateState, requestId);
            result.stateCommitted = true;
            result.stateHash = committed?.hash ?? hash;
          }
        } catch (error) {
          rejectCommit("failed", {
            code: "state_commit_failed",
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }
    execution.signal.removeEventListener("abort", onAbort);
    terminal.result = result;
    return result;
  } finally {
    execution.dispose();
    dispatchAbort.dispose();
  }
}
