// Host-side exec runner (C1/C2/C3): spawns the disposable exec worker, wires
// its fixed-method RPCs to the driver (strictly serially), enforces the
// action budget and wall-clock timeout, commits state on clean completion
// only, and builds the ExecResult from HOST-side observations — the script
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

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ComputerError } from "@ya-skills/computer-runtime";
import type { ActionReceipt, BatchRequest, Condition, ObserveOptions, Observation } from "@ya-skills/computer-runtime";
import { validateBatch } from "@ya-skills/computer-runtime";
import { internalSpawnCommand, stopProcessGroup, TERM_GRACE_MS } from "./process.js";
import { FrameReader, MAX_MESSAGE_BYTES } from "./protocol.js";
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

/** Host-side cap on captured worker stdout/stderr (bytes each). */
const EXEC_WORKER_STDOUT_CAP = 64 * 1024;
/** Host-side cap on RPCs queued but not yet dispatched. */
const EXEC_RPC_QUEUE_LIMIT = 64;
/** Bounded wait for the in-flight native dispatch at request end (F3). */
const NATIVE_SETTLE_MS = 5_000;
/** Leave room for the session reply envelope around ExecResult. */
const EXEC_RESULT_MAX_BYTES = MAX_MESSAGE_BYTES - 4 * 1024;

function closeOwnedFd(fd: number): void {
  try {
    closeSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EBADF") throw error;
  }
}

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

let execSpawnTail: Promise<void> = Promise.resolve();

async function spawnExecWorkerWithRetry(
  command: string,
  args: string[],
  options: Parameters<typeof spawn>[2]
): Promise<ChildProcess> {
  // Bun 1.3.14 has a process-wide race while several callers create four
  // stdio pipes at once. Serialize only the synchronous spawn setup (not the
  // worker execution) so independent session requests still run in parallel
  // without losing a child before its control fd is attached.
  const previous = execSpawnTail;
  let release!: () => void;
  execSpawnTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  let lastError: unknown;
  // Bun 1.3.14 can fail synchronously while creating the four stdio pipes
  // under concurrent desktop-free tests. No child exists on this path, so a
  // bounded retry is safe and does not replay script/native work. The longer
  // backoff covers the full-suite descriptor contention without changing the
  // exec request's own timeout budget (the worker has not started yet).
  try {
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        return spawn(command, args, options);
      } catch (error) {
        lastError = error;
        if (attempt < 11) await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  } finally {
    release();
  }
}

export interface ExecDeps {
  sessionId: string;
  generation: string;
  target: { pid: number; windowId: bigint };
  stateDir: string;
  /** Serial driver call dispatcher (host-owned). The runner supplies its
   * request-local signal so timeout/cancel closes native admission too. */
  driverCall(method: "observe" | "batch", args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  /** One auto-observation at the end when the script made none. Errors
   * PROPAGATE (F14): the runner records final_observe_failed. */
  finalObserve(signal?: AbortSignal, deadlineAt?: number): Promise<Observation | null>;
  /** Live-worker tracking for lease ownership + diagnostics (F2/F23). */
  onExecWorkerSpawn?(pid: number | null): Promise<void> | void;
  onExecWorkerExit?(pid: number | null): Promise<void> | void;
  /** Persist an unresolved process-group identity before the host can die. */
  onExecWorkerCleanupFailed?(pid: number | null, pgid: number | null): Promise<void> | void;
  /** Durable journal hooks. The started hook is awaited before native
   * dispatch; the finished hook is awaited before the request can finish. */
  onActionStarted?(index: number, kind: ActionReceipt["kind"]): Promise<void> | void;
  onActionFinished?(
    index: number,
    kind: ActionReceipt["kind"],
    outcome: ActionReceipt["status"],
    error?: { code: string; message: string }
  ): Promise<void> | void;
  /** Durable journal intent written before the host commits state. */
  onStateCommitIntent?(intent: { expectedVersion: number; version: number; hash: string }): Promise<void> | void;
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
  const dispatchAbort = new AbortController();
  const onParentAbort = () => dispatchAbort.abort();
  if (signal?.aborted) dispatchAbort.abort();
  else signal?.addEventListener("abort", onParentAbort, { once: true });
  const receipts: ActionReceipt[] = [];
  const observations: Observation[] = [];
  let logs: string[] = [];
  let actionCount = 0;
  let mutationsSinceObservation = 0;
  let admissionClosed = false;
  let stateVersion = stateBefore.version;
  let scriptObserved = false;
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

  if (runDeadlineAt <= Date.now() || signal?.aborted) {
    signal?.removeEventListener("abort", onParentAbort);
    return {
      status: signal?.aborted ? "interrupted" : "failed",
      stateVersion: stateBefore.version,
      stateCommitted: false,
      actions: receipts,
      observations,
      logs,
      error: {
        code: signal?.aborted ? "request_cancelled" : "execution_timeout",
        message: signal?.aborted ? "the exec request was cancelled before worker start" : "the execution budget expired before worker start"
      }
    };
  }

  // The script's working directory is its source file's directory (C1/P2.1);
  // the worker boots in a private dir and chdirs after reading the config.
  const sourceAbsolute = isAbsolute(options.sourceName)
    ? options.sourceName
    : resolve(process.cwd(), options.sourceName);
  const scriptCwd = dirname(sourceAbsolute);

  const configDir = await mkdtemp(join(tmpdir(), "yk-cu-exec-"));
  const configPath = join(configDir, "exec.json");
  const controlPath = join(configDir, "control.spool");
  const bootCwd = join(configDir, "boot");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(bootCwd, { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      sessionId: deps.sessionId,
      requestId,
      generation: deps.generation,
      target: { pid: deps.target.pid, windowId: deps.target.windowId.toString() },
      code: options.code,
      sourceName: options.sourceName,
      timeoutMs: options.timeoutMs,
      maxActions: options.maxActions,
      state: stateBefore.value,
      cwd: scriptCwd
    }),
    { mode: 0o600 }
  );
  const { command, args } = internalSpawnCommand("__computer-exec-worker", configPath);
  // A regular file avoids Bun 1.3.14's concurrent fourth-pipe setup race.
  // The worker still writes the same fd3 NDJSON control protocol; the host
  // tails this private spool incrementally while stdin remains the reply pipe.
  const controlWriteFd = openSync(controlPath, "a", 0o600);
  let child: ChildProcess;
  try {
    child = await spawnExecWorkerWithRetry(command, args, {
      detached: true,
      // fd3 = control spool; stdout/stderr are pure logs (F16).
      stdio: ["pipe", "pipe", "pipe", controlWriteFd],
      cwd: bootCwd,
      env: { ...process.env }
    });
  } catch (error) {
    closeOwnedFd(controlWriteFd);
    await rm(configDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  // The child has its own inherited fd3; the parent tails through a separate
  // read descriptor so the append offset never affects polling.
  closeOwnedFd(controlWriteFd);
  const controlReadFd = openSync(controlPath, "r");
  try {
    await deps.onExecWorkerSpawn?.(child.pid ?? null);
  } catch (error) {
    await stopProcessGroup(child, TERM_GRACE_MS).catch(() => undefined);
    closeOwnedFd(controlReadFd);
    await rm(configDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  let settled = false;
  let exitInfo: { code: number | null; signal: string | null } | null = null;
  const rpcWaiters = new Map<number, { resolve: (v: JsonValue) => void; reject: (e: unknown) => void }>();
  const terminal: { result?: ExecResult } = {};
  /** The native dispatch currently in flight (F3): a terminal reply waits
   * for it (bounded) instead of leaving native work behind an idle session. */
  let inFlightNative: Promise<unknown> | null = null;
  let queuedDispatches = 0;
  let pendingCommit: { value: JsonValue; state: Record<string, JsonValue>; result: ExecResult } | null = null;
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
    for (const waiter of rpcWaiters.values()) {
      waiter.reject(new ComputerError("exec_finished", "the exec request has finished"));
    }
    rpcWaiters.clear();
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

  const registerObservation = (observation: Observation): Observation => {
    if (observations.length >= EXEC_MAX_OBSERVATIONS) {
      runLimitError = {
        code: "observation_limit",
        message: `the script exceeded the limit of ${EXEC_MAX_OBSERVATIONS} returned observations — observe less or rely on state`
      };
      admissionClosed = true;
      throw new ComputerError("observation_limit", runLimitError.message);
    }
    observations.push(observation);
    scriptObserved = true;
    mutationsSinceObservation = 0;
    return observation;
  };

  const addReceipt = async (
    receipt: ActionReceipt,
    batchSteps?: ActionReceipt[]
  ): Promise<void> => {
    receipts.push(receipt);
    batchSteps?.push(receipt);
    await deps.onActionFinished?.(receipt.index, receipt.kind, receipt.status, receipt.error);
  };

  const fillNotRun = async (
    actions: readonly { kind: ActionReceipt["kind"] }[],
    from: number,
    batchSteps?: ActionReceipt[],
    error?: { code: string; message: string },
    indexOffset = 0
  ): Promise<void> => {
    for (let index = from; index < actions.length; index++) {
      const receipt: ActionReceipt = {
        index: indexOffset + index,
        kind: actions[index]!.kind,
        status: "not_run",
        ...(error !== undefined ? { error } : {})
      };
      await addReceipt(receipt, batchSteps);
    }
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
        const runAdmissionError = (): ComputerError | null => admissionError();
        const beforeRunError = runAdmissionError();
        if (beforeRunError !== null) {
          // The worker may emit exec_unawaited immediately after an RPC
          // frame; the host can therefore reject a queued call before its
          // first step starts. Preserve a receipt for every such call.
          if (!receipts.some((receipt) => receipt.index === index)) {
            if (method === "batch") {
              try {
                const request = validateBatch(rpcArgs.request);
                await fillNotRun(request.actions, 0, undefined, { code: beforeRunError.code, message: beforeRunError.message }, index);
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
        nativeCall = (async () => {
          if (method === "observe") {
            const beforeObserve = runAdmissionError();
            if (beforeObserve !== null) throw beforeObserve;
            const observation = (await deps.driverCall("observe", {
              options: (rpcArgs.options as ObserveOptions | undefined) ?? { mode: "auto" },
              deadlineAt: runDeadlineAt
            }, dispatchAbort.signal)) as Observation;
            const afterObserve = runAdmissionError();
            if (afterObserve !== null) throw afterObserve;
            return registerObservation(observation);
          }
          if (method === "batch") {
            const request = validateBatch(rpcArgs.request);
            const batchSteps: ActionReceipt[] = [];
            let batchStatus: "completed" | "interrupted" | "failed" = "completed";
            const batchDeadlineAt = Math.min(
              runDeadlineAt,
              Date.now() + (request.timeoutMs ?? 30_000)
            );
            for (const [stepIndex, action] of request.actions.entries()) {
              const eventIndex = index + stepIndex;
              const boundary = runAdmissionError();
              if (boundary !== null || Date.now() >= batchDeadlineAt) {
                const error = boundary === null
                  ? { code: "batch_deadline", message: "the batch timeout budget expired before this action was dispatched" }
                  : { code: boundary.code, message: boundary.message };
                await fillNotRun(request.actions, stepIndex, batchSteps, error, index);
                batchStatus = "interrupted";
                break;
              }
              await deps.onActionStarted?.(eventIndex, action.kind);
              const afterJournal = runAdmissionError();
              if (afterJournal !== null || Date.now() >= batchDeadlineAt) {
                const error = afterJournal === null
                  ? { code: "batch_deadline", message: "the batch timeout budget expired before this action was dispatched" }
                  : { code: afterJournal.code, message: afterJournal.message };
                await fillNotRun(request.actions, stepIndex, batchSteps, error, index);
                batchStatus = "interrupted";
                break;
              }
              const remaining = batchDeadlineAt - Date.now();
              const oneRequest: BatchRequest = {
                actions: [action],
                timeoutMs: Math.max(1, Math.min(remaining, 120_000)),
                maxActions: 1
              };
              let result: { status: string; steps?: ActionReceipt[] };
              try {
                result = (await deps.driverCall("batch", { request: oneRequest }, dispatchAbort.signal)) as {
                  status: string;
                  steps?: ActionReceipt[];
                };
              } catch (error) {
                // A mutation batch that loses its host/driver response has
                // unknown delivery even when the transport error is plain.
                markUnknownDelivery();
                const failure = {
                  code: error instanceof ComputerError ? error.code : "action_failed",
                  message: error instanceof Error ? error.message : String(error)
                };
                const receipt: ActionReceipt = { index: eventIndex, kind: action.kind, status: "unknown", error: failure };
                await addReceipt(receipt, batchSteps);
                await fillNotRun(request.actions, stepIndex + 1, batchSteps, {
                  code: "not_run_after_unknown",
                  message: "the preceding action had unknown delivery; remaining actions were not dispatched"
                }, index);
                batchStatus = "interrupted";
                break;
              }
              const local = result.steps?.[0];
              const outcome = local?.status ?? "unknown";
              const receipt: ActionReceipt = {
                ...(local ?? {}),
                index: eventIndex,
                kind: action.kind,
                status: outcome
              } as ActionReceipt;
              await addReceipt(receipt, batchSteps);
              if (outcome === "delivered" || outcome === "satisfied") {
                // A local wait may have observed an externally changed frame;
                // treat the facade call as observation-dirty so the final
                // result does not reuse a pre-wait snapshot.
                mutationsSinceObservation++;
                const afterAction = runAdmissionError();
                if (afterAction !== null || Date.now() >= batchDeadlineAt) {
                  const error = afterAction === null
                    ? { code: "batch_deadline", message: "the batch timeout budget expired after this action" }
                    : { code: afterAction.code, message: afterAction.message };
                  await fillNotRun(request.actions, stepIndex + 1, batchSteps, error, index);
                  batchStatus = "interrupted";
                  break;
                }
                continue;
              }
              if (outcome === "unknown") markUnknownDelivery();
              await fillNotRun(request.actions, stepIndex + 1, batchSteps, {
                code: receipt.error?.code ?? (outcome === "unknown" ? "unknown_delivery" : "action_failed"),
                message: receipt.error?.message ?? `the action ended with ${outcome}`
              }, index);
              batchStatus = outcome === "unknown" || result.status === "interrupted" ? "interrupted" : "failed";
              break;
            }
            if (batchStatus === "completed" && request.observe !== undefined) {
              const beforeObservation = runAdmissionError();
              if (beforeObservation !== null || Date.now() >= batchDeadlineAt) {
                const error = beforeObservation === null
                  ? { code: "batch_deadline", message: "the batch timeout budget expired before final observation" }
                  : { code: beforeObservation.code, message: beforeObservation.message };
                return { status: "interrupted", steps: batchSteps, observationError: error };
              }
              try {
                const observation = (await deps.driverCall(
                  "observe",
                  { options: request.observe, deadlineAt: batchDeadlineAt },
                  dispatchAbort.signal
                )) as Observation;
                if (Date.now() >= batchDeadlineAt || signal?.aborted) {
                  return {
                    status: "interrupted",
                    steps: batchSteps,
                    observationError: { code: signal?.aborted ? "request_cancelled" : "batch_deadline", message: signal?.aborted ? "the batch was cancelled during final observation" : "the batch timeout budget expired during final observation" }
                  };
                }
                registerObservation(observation);
                return { status: batchStatus, steps: batchSteps, observation };
              } catch (error) {
                return {
                  status: batchStatus,
                  steps: batchSteps,
                  observationError: {
                    code: error instanceof ComputerError ? error.code : "final_observe_failed",
                    message: error instanceof Error ? error.message : String(error)
                  }
                };
              }
            }
            return { status: batchStatus, steps: batchSteps };
          }
          // Single actions ride a one-step batch so receipts and selector/
          // condition validation stay in ONE implementation.
          const kind = method as ActionReceipt["kind"];
          const beforeSingle = runAdmissionError();
          if (beforeSingle !== null) {
            const receipt: ActionReceipt = { index, kind, status: "not_run", error: { code: beforeSingle.code, message: beforeSingle.message } };
            await addReceipt(receipt);
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
            const receipt: ActionReceipt = { index, kind, status: "not_run", error: { code: afterValidation.code, message: afterValidation.message } };
            await addReceipt(receipt);
            throw afterValidation;
          }
          let result: { status: string; steps?: ActionReceipt[] };
          try {
            result = (await deps.driverCall("batch", { request: single }, dispatchAbort.signal)) as {
              status: string;
              steps?: ActionReceipt[];
            };
          } catch (error) {
            // The native mutation crossed the host boundary. A missing or
            // unclassified response is never an ordinary script failure.
            markUnknownDelivery();
            const failure = {
              code: error instanceof ComputerError ? error.code : "action_failed",
              message: error instanceof Error ? error.message : String(error)
            };
            await addReceipt({ index, kind, status: "unknown", error: failure });
            throw error;
          }
          const step = result.steps?.[0];
          const status = step?.status ?? "unknown";
          const receipt: ActionReceipt = {
            ...(step ?? {}),
            index,
            kind,
            status
          } as ActionReceipt;
          await addReceipt(receipt);
          if (status === "delivered" || status === "satisfied") {
            mutationsSinceObservation++;
            // The runtime has already validated the native set_value result
            // before producing a delivered receipt. Return its narrow proof
            // to the script facade; do not reconstruct it from a generic
            // driver response in the worker.
            return method === "set_value" && status === "delivered"
              ? { route: "accessibility", effect: "confirmed" }
              : null;
          }
          // A failed single-action RPC REJECTS the script call with its
          // receipt error (F6): `await computer.wait(...)` timeouts, refused
          // clicks, and unsupported conditions stop the flow instead of
          // resolving successfully.
          if (status === "unknown") {
            markUnknownDelivery();
          }
          throw new ComputerError(
            step?.error?.code ?? "action_failed",
            step?.error?.message ?? `${method} did not complete (${status})`,
            status === "unknown" ? "unknown" : "not_delivered"
          );
        })();
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
            stateVersion: stateBefore.version,
            stateCommitted: false,
            actions: receipts,
            observations,
            logs,
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
            stateVersion: stateBefore.version,
            stateCommitted: false,
            actions: receipts,
            observations,
            logs,
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
            stateVersion: stateBefore.version,
            stateCommitted: false,
            actions: receipts,
            observations,
            logs
          };
          const bounded = boundedResult(candidate, requestId);
          if (bounded !== candidate || bounded.error?.code === "result_limit") {
            finish(bounded);
          } else {
            // State commitment is finalized after worker/group cleanup and the
            // required final observation. This lets the host reject an
            // oversized aggregate before committing, while a final-read
            // failure still commits the already-valid script state factually.
            pendingCommit = { value: validatedValue, state: validatedState, result: candidate };
            finish(candidate);
          }
        } catch (error) {
          finish({
            status: "failed",
            stateVersion: stateBefore.version,
            stateCommitted: false,
            actions: receipts,
            observations,
            logs,
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
          stateVersion: stateBefore.version,
          stateCommitted: false,
          actions: receipts,
          observations,
          logs,
          error
        });
        return;
      }
      case "exec_unawaited": {
        if (settled) return;
        logs = (message.logs as string[]) ?? [];
        finish({
          status: runUnknownDelivery ? "unknown" : runLimitError?.code === "request_cancelled" || signal?.aborted ? "interrupted" : "failed",
          stateVersion: stateBefore.version,
          stateCommitted: false,
          actions: receipts,
          observations,
          logs,
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

  const controlReader = new FrameReader();
  let controlOffset = 0;
  let controlPollFailed = false;
  const CONTROL_CHUNK_BYTES = 64 * 1024;
  const processControlChunk = (chunk: Buffer): void => {
    let frames: string[];
    try {
      frames = controlReader.push(chunk);
    } catch {
      // Oversized/malformed control frame: treat as a protocol failure and
      // reclaim the worker.
      controlPollFailed = true;
      admissionClosed = true;
      void stopProcessGroup(child, TERM_GRACE_MS);
      return;
    }
    for (const line of frames) {
      if (line.trim() !== "") handleWorkerLine(line);
    }
  };
  const pollControl = (): void => {
    if (controlPollFailed) return;
    try {
      const size = statSync(controlPath).size;
      const remaining = size - controlOffset;
      if (remaining <= 0) return;
      // Keep each poll bounded; FrameReader carries partial UTF-8/frame data.
      const requested = Math.min(CONTROL_CHUNK_BYTES, remaining);
      const buffer = Buffer.allocUnsafe(requested);
      const count = readSync(controlReadFd, buffer, 0, requested, controlOffset);
      if (count <= 0) return;
      controlOffset += count;
      processControlChunk(buffer.subarray(0, count));
    } catch {
      controlPollFailed = true;
      admissionClosed = true;
      void stopProcessGroup(child, TERM_GRACE_MS);
    }
  };
  /**
   * The worker writes its terminal frame synchronously and may exit before
   * the interval gets another turn. A single bounded poll is insufficient:
   * the terminal frame can span many chunks. Keep reading until a second EOF
   * probe observes the same offset. The second probe also catches a writer
   * that appended between the size check and the first probe.
   */
  const drainControlToEof = (): void => {
    if (controlPollFailed) return;
    let stableOffset: number | null = null;
    while (!controlPollFailed) {
      try {
        const before = controlOffset;
        pollControl();
        if (controlPollFailed) return;

        const size = statSync(controlPath).size;
        if (size < controlOffset) {
          throw new Error("the exec control spool shrank before EOF was verified");
        }
        if (size > controlOffset || controlOffset !== before) {
          stableOffset = null;
          continue;
        }

        // A regular-file read at the current offset is the explicit EOF
        // probe. Do not infer EOF only from stat: a child may append after
        // that call.
        const probe = Buffer.allocUnsafe(1);
        const count = readSync(controlReadFd, probe, 0, 1, controlOffset);
        if (count > 0) {
          controlOffset += count;
          processControlChunk(probe.subarray(0, count));
          stableOffset = null;
          continue;
        }
        const afterProbe = statSync(controlPath).size;
        if (afterProbe < controlOffset) {
          throw new Error("the exec control spool shrank during EOF verification");
        }
        if (afterProbe !== controlOffset) {
          stableOffset = null;
          continue;
        }
        if (stableOffset === controlOffset) return;
        stableOffset = controlOffset;
      } catch {
        // A truncated or unreadable spool cannot prove terminal delivery.
        // Stop polling and fail closed; never spin or let a malformed tail
        // keep the request alive indefinitely.
        controlPollFailed = true;
        admissionClosed = true;
        void stopProcessGroup(child, TERM_GRACE_MS);
        return;
      }
    }
  };
  const controlTimer = setInterval(pollControl, 10);
  controlTimer.unref();

  // stdout/stderr are LOGS: bounded host-side capture; overflow cancels the
  // script immediately (F16) — it can never keep issuing desktop actions.
  const stdoutCapture: string[] = [];
  const stderrCapture: string[] = [];
  let outputBytes = 0;
  let outputOverflow = false;
  const outputDecoders = {
    stdout: new TextDecoder("utf-8", { fatal: true }),
    stderr: new TextDecoder("utf-8", { fatal: true })
  };
  const capture = (kind: "stdout" | "stderr", chunk: Buffer): void => {
    if (outputOverflow) return;
    const bytes = chunk.byteLength;
    if (outputBytes + bytes > EXEC_WORKER_STDOUT_CAP) {
      outputOverflow = true;
      admissionClosed = true;
      finish({
        status: runUnknownDelivery ? "unknown" : "interrupted",
        stateVersion: stateBefore.version,
        stateCommitted: false,
        actions: receipts,
        observations,
        logs,
        error: {
          code: "output_limit",
          message: `the script's combined stdout/stderr exceeded ${EXEC_WORKER_STDOUT_CAP} bytes — execution cancelled at the limit`
        }
      });
      void stopProcessGroup(child, TERM_GRACE_MS);
      return;
    }
    let decoded: string;
    try {
      decoded = outputDecoders[kind].decode(chunk, { stream: true });
    } catch {
      outputOverflow = true;
      admissionClosed = true;
      finish({
        status: "failed",
        stateVersion: stateBefore.version,
        stateCommitted: false,
        actions: receipts,
        observations,
        logs,
        error: { code: "protocol_utf8", message: `${kind} log output is not valid UTF-8` }
      });
      void stopProcessGroup(child, TERM_GRACE_MS);
      return;
    }
    outputBytes += bytes;
    if (kind === "stdout") stdoutCapture.push(decoded);
    else stderrCapture.push(decoded);
  };
  child.stdout!.on("data", (chunk: Buffer) => capture("stdout", chunk));
  child.stderr!.on("data", (chunk: Buffer) => capture("stderr", chunk));

  child.on("exit", (code, signal) => {
    // A short script can write exec_done and exit before the first interval
    // tick. Drain its regular-file control stream to a verified EOF before
    // treating the exit as a missing terminal frame.
    drainControlToEof();
    exitInfo = { code, signal: signal ?? null };
    if (!settled) {
      finish({
        status: runUnknownDelivery ? "unknown" : code === 0 || signal === "SIGTERM" ? "interrupted" : "failed",
        stateVersion: stateBefore.version,
        stateCommitted: false,
        actions: receipts,
        observations,
        logs,
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
        stateVersion: stateBefore.version,
        stateCommitted: false,
        actions: receipts,
        observations,
        logs,
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
          stateVersion: stateBefore.version,
          stateCommitted: false,
          actions: receipts,
          observations,
          logs,
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
  signal?.addEventListener("abort", onAbort, { once: true });
  const watchdog = setTimeout(
    () => stopWorker(`the script exceeded ${options.timeoutMs}ms`, "execution_timeout"),
    Math.max(runDeadlineAt - Date.now(), 1)
  );

  try {
    const deadline = runDeadlineAt + TERM_GRACE_MS + NATIVE_SETTLE_MS;
    while (!settled && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!settled) {
      finish({
        status: "unknown",
        stateVersion: stateBefore.version,
        stateCommitted: false,
        actions: receipts,
        observations,
        logs,
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
    drainControlToEof();
    closeOwnedFd(controlReadFd);
    await rm(configDir, { recursive: true, force: true }).catch(() => undefined);
  }

  let result = terminal.result!;
  // Attach captured worker stdout/stderr overflow diagnostics when present.
  if (stdoutCapture.length > 0 || stderrCapture.length > 0) {
    (result as ExecResult & { workerOutput?: { stdout?: string; stderr?: string } }).workerOutput = {
      ...(stdoutCapture.length > 0 ? { stdout: stdoutCapture.join("").slice(-16 * 1024) } : {}),
      ...(stderrCapture.length > 0 ? { stderr: stderrCapture.join("").slice(-16 * 1024) } : {})
    };
  }
  // Final observation (F14): append a fresh observation when the script never
  // observed, OR when mutations happened after its last observation. A prior
  // observation is reused ONLY when nothing mutated since (no stale reuse).
  if (result.status === "completed" && (!scriptObserved || mutationsSinceObservation > 0 || observations.length === 0)) {
    if (cancellationRequested()) {
      result.status = "interrupted";
      result.stateCommitted = false;
      result.error = { code: "request_cancelled", message: "the exec request was cancelled before final observation/commit" };
      pendingCommit = null;
    } else if (executionTimedOut()) {
      result.status = "failed";
      result.stateCommitted = false;
      // The script state is a factual local result even when the final read
      // could not begin before the wall-clock budget. Preserve it for the
      // post-timeout commit path; no further desktop input is attempted.
      result.error = { code: "final_observe_failed", message: "the execution budget expired before the final observation" };
    } else if (observations.length >= EXEC_MAX_OBSERVATIONS) {
      result.status = "failed";
      result.error = {
        code: "observation_limit",
        message: `the required final observation would exceed the limit of ${EXEC_MAX_OBSERVATIONS}; no fresh evidence was silently dropped`
      };
      pendingCommit = null;
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
            if (cancellationRequested()) {
              result.status = "interrupted";
              result.error = { code: "request_cancelled", message: "the exec request was cancelled during final observation" };
            } else {
              result.status = "failed";
              result.error = { code: "final_observe_failed", message: "the execution budget expired during final observation" };
            }
            result.stateCommitted = false;
            pendingCommit = null;
          } else {
            registerObservation(final);
          }
        } catch (error) {
          if (cancellationRequested()) {
            result.status = "interrupted";
            result.error = { code: "request_cancelled", message: "the exec request was cancelled during final observation" };
            result.stateCommitted = false;
            pendingCommit = null;
          } else if (error instanceof ComputerError && error.code === "observation_limit") {
            result.status = "failed";
            result.error = { code: error.code, message: error.message };
            result.stateCommitted = false;
            pendingCommit = null;
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
              result.status = "unknown";
              result.stateCommitted = false;
              result.error = {
                code: "native_in_flight",
                message: "the final observation was still executing when the request ended — delivery state is unknown"
              };
              pendingCommit = null;
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
    result.status = "unknown";
    result.stateCommitted = false;
    result.error = {
      code: "unknown_delivery",
      message: "native delivery or worker cleanup was not proven; state was not committed"
    };
    pendingCommit = null;
  } else if (cancellationRequested()) {
    result.status = "interrupted";
    result.stateCommitted = false;
    result.error = { code: "request_cancelled", message: "the exec request was cancelled; state was not committed" };
    pendingCommit = null;
  } else if (result.status === "completed" && Date.now() >= runDeadlineAt) {
    result.status = "failed";
    result.stateCommitted = false;
    result.error = { code: "execution_timeout", message: "the execution budget expired before state commit" };
    pendingCommit = null;
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
    const hash = execStateHash(pendingCommit.state);
    const deadlineBlocksCommit = Date.now() >= runDeadlineAt && result.error?.code !== "final_observe_failed";
    const abortBlocksCommit = dispatchAbort.signal.aborted && result.error?.code !== "final_observe_failed";
    if (signal?.aborted || abortBlocksCommit || deadlineBlocksCommit) {
      result.status = signal?.aborted ? "interrupted" : "failed";
      result.stateCommitted = false;
      result.error = signal?.aborted
        ? { code: "request_cancelled", message: "the exec request was cancelled before state commit" }
        : { code: "execution_timeout", message: "the execution budget expired before state commit" };
      pendingCommit = null;
    } else {
      try {
        await deps.onStateCommitIntent?.({
          expectedVersion: stateBefore.version,
          version: stateBefore.version + 1,
          hash
        });
        const finalReadFailed = result.error?.code === "final_observe_failed";
        if (signal?.aborted || (dispatchAbort.signal.aborted && !finalReadFailed) || (Date.now() >= runDeadlineAt && !finalReadFailed)) {
          result.status = signal?.aborted ? "interrupted" : "failed";
          result.stateCommitted = false;
          result.error = signal?.aborted
            ? { code: "request_cancelled", message: "the exec request was cancelled during state commit" }
            : { code: "execution_timeout", message: "the execution budget expired during state commit" };
          pendingCommit = null;
        } else {
          stateVersion = commitExecState(deps.stateDir, stateBefore.version, pendingCommit.state, requestId);
          result.stateVersion = stateVersion;
          result.stateCommitted = true;
          result.stateHash = hash;
        }
      } catch (error) {
        result.status = "failed";
        result.stateCommitted = false;
        result.error = {
          code: "state_commit_failed",
          message: error instanceof Error ? error.message : String(error)
        };
      }
    }
  }
  clearTimeout(watchdog);
  signal?.removeEventListener("abort", onAbort);
  signal?.removeEventListener("abort", onParentAbort);
  terminal.result = result;
  void exitInfo;
  return result;
}

function singleActionBatch(method: ScriptRpcMethod, args: Record<string, JsonValue>): BatchRequest {
  switch (method) {
    case "click":
      return { actions: [{ kind: "click", selector: args.selector as never }] };
    case "click_point":
      return { actions: [{ kind: "click_point", point: args.point as never }] };
    case "set_value":
      return {
        actions: [{
          kind: "set_value",
          elementToken: String(args.elementToken ?? ""),
          value: String(args.value ?? "")
        }]
      };
    case "type":
      return {
        actions: [
          {
            kind: "type",
            text: String(args.text ?? ""),
            ...((args.before as Condition | undefined) !== undefined ? { before: args.before as Condition } : {})
          }
        ]
      };
    case "key":
      return {
        actions: [
          {
            kind: "key",
            key: String(args.key ?? ""),
            ...(Array.isArray(args.modifiers) ? { modifiers: args.modifiers as string[] } : {}),
            ...((args.before as Condition | undefined) !== undefined ? { before: args.before as Condition } : {})
          }
        ]
      };
    case "scroll":
      return { actions: [{ kind: "scroll", spec: args.spec as never }] };
    case "wait":
      return {
        actions: [
          {
            kind: "wait",
            condition: args.condition as never,
            timeoutMs: Number(args.timeoutMs ?? 1_000)
          }
        ]
      };
    default:
      throw new ComputerError("invalid_request", `${method} is not a single action`);
  }
}
