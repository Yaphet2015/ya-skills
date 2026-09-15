// Host-side exec runner (C1/C2/C3): spawns the disposable exec worker, wires
// its fixed-method RPCs to the driver (strictly serially), enforces the
// action budget and wall-clock timeout, commits state on clean completion
// only, and builds the ExecResult from HOST-side observations — the script
// never self-reports success.
//
// Channel split (F16): fd4 is the CONTROL channel (RPC requests/replies,
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

function jsonBytes(value: unknown): number {
  const encoded = JSON.stringify(value, (_key, entry) => (typeof entry === "bigint" ? entry.toString() : entry));
  return Buffer.byteLength(encoded ?? "null", "utf8");
}

function boundedResult(result: ExecResult, requestId: string): ExecResult {
  const envelope = { schemaVersion: 1, requestId, status: result.status, result };
  if (jsonBytes(envelope) <= EXEC_RESULT_MAX_BYTES) return result;
  const dropped = result.observations.length;
  const bounded: ExecResult = {
    ...result,
    status: "failed",
    stateCommitted: false,
    observations: [],
    ...(dropped > 0 ? { observationsDropped: dropped } : {}),
    error: {
      code: "result_limit",
      message: `the aggregate exec result exceeds the ${EXEC_RESULT_MAX_BYTES}-byte wire budget; bounded receipts were retained and ${dropped} observation(s) omitted`
    }
  };
  if (jsonBytes({ schemaVersion: 1, requestId, status: bounded.status, result: bounded }) <= EXEC_RESULT_MAX_BYTES) {
    return bounded;
  }
  // Values/logs are user-controlled too. Keep action receipts as the minimum
  // recovery evidence if a pathological return value still fills the frame.
  return {
    ...bounded,
    value: null,
    logs: [],
    observationsDropped: dropped,
    error: {
      code: "result_limit",
      message: "the aggregate exec result exceeded the wire budget; only bounded action receipts were retained"
    }
  };
}

async function spawnExecWorkerWithRetry(
  command: string,
  args: string[],
  options: Parameters<typeof spawn>[2]
): Promise<ChildProcess> {
  let lastError: unknown;
  // Bun 1.3.14 can fail synchronously while creating the four stdio pipes
  // under concurrent desktop-free tests. No child exists on this path, so a
  // bounded retry is safe and does not replay script/native work.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return spawn(command, args, options);
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export interface ExecDeps {
  sessionId: string;
  generation: string;
  target: { pid: number; windowId: bigint };
  stateDir: string;
  /** Serial driver call dispatcher (host-owned). */
  driverCall(method: "observe" | "batch", args: Record<string, unknown>): Promise<unknown>;
  /** One auto-observation at the end when the script made none. Errors
   * PROPAGATE (F14): the runner records final_observe_failed. */
  finalObserve(): Promise<Observation | null>;
  /** Live-worker tracking for lease ownership + diagnostics (F2/F23). */
  onExecWorkerSpawn?(pid: number | null): Promise<void> | void;
  onExecWorkerExit?(pid: number | null): Promise<void> | void;
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
  const stateBefore = loadExecState(deps.stateDir);
  const receipts: ActionReceipt[] = [];
  const observations: Observation[] = [];
  let logs: string[] = [];
  let actionCount = 0;
  let mutationsSinceObservation = 0;
  let admissionClosed = false;
  let stateVersion = stateBefore.version;
  let scriptObserved = false;
  let runDeadlineAt = Date.now() + options.timeoutMs;
  /** Run-level unknown delivery (F6): no state commit, terminal unknown. */
  let runUnknownDelivery = false;
  /** Hard resource boundaries are terminal even if user code catches the
   * rejected facade promise; they must not later commit state as success. */
  let runLimitError: { code: string; message: string } | null = null;
  const markUnknownDelivery = (): void => {
    runUnknownDelivery = true;
    admissionClosed = true;
  };

  // The script's working directory is its source file's directory (C1/P2.1);
  // the worker boots in a private dir and chdirs after reading the config.
  const sourceAbsolute = isAbsolute(options.sourceName)
    ? options.sourceName
    : resolve(process.cwd(), options.sourceName);
  const scriptCwd = dirname(sourceAbsolute);

  const configDir = await mkdtemp(join(tmpdir(), "yk-cu-exec-"));
  const configPath = join(configDir, "exec.json");
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
  const child: ChildProcess = await spawnExecWorkerWithRetry(command, args, {
    detached: true,
    // fd4 = control channel; stdout/stderr are pure logs (F16).
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    cwd: bootCwd,
    env: { ...process.env }
  });
  try {
    await deps.onExecWorkerSpawn?.(child.pid ?? null);
  } catch (error) {
    await stopProcessGroup(child, TERM_GRACE_MS).catch(() => undefined);
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
    settled = true;
    terminal.result = result;
    for (const waiter of rpcWaiters.values()) {
      waiter.reject(new ComputerError("exec_finished", "the exec request has finished"));
    }
    rpcWaiters.clear();
  };

  // Driver-side dispatch: one RPC at a time, host-generated receipts. The
  // chain SERIALIZES the actual driver calls — two facade actions can never
  // be in the driver at once (F3).
  let dispatchChain: Promise<unknown> = Promise.resolve();
  const dispatchRpc = (method: ScriptRpcMethod, rpcArgs: Record<string, JsonValue>): Promise<JsonValue> => {
    if (admissionClosed || settled) {
      return Promise.reject(new ComputerError("exec_finished", "the exec request is no longer accepting RPCs"));
    }
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
      if (admissionClosed || settled) {
        throw new ComputerError("exec_finished", "the exec request is no longer accepting RPCs");
      }
      let nativeCall: Promise<unknown> = Promise.resolve();
      try {
        nativeCall = (async () => {
          if (method === "observe") {
            const observation = (await deps.driverCall("observe", {
              options: (rpcArgs.options as ObserveOptions | undefined) ?? { mode: "auto" }
            })) as Observation;
            if (observations.length >= EXEC_MAX_OBSERVATIONS) {
              // Observation overflow FAILS the call loudly (F16): the limit
              // is a cancellation boundary, not a silent truncation.
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
          }
          if (method === "batch") {
            const request = validateBatch(rpcArgs.request);
            const batchSteps: ActionReceipt[] = [];
            let batchStatus: "completed" | "interrupted" | "failed" = "completed";
            for (const [stepIndex, action] of request.actions.entries()) {
              const eventIndex = index + stepIndex;
              await deps.onActionStarted?.(eventIndex, action.kind);
              const oneRequest: BatchRequest = {
                actions: [action],
                timeoutMs: Math.max(1, Math.min(request.timeoutMs ?? 30_000, 120_000)),
                maxActions: 1
              };
              let result: { status: string; steps?: ActionReceipt[] };
              try {
                result = (await deps.driverCall("batch", { request: oneRequest })) as {
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
                batchSteps.push(receipt);
                receipts.push(receipt);
                await deps.onActionFinished?.(eventIndex, action.kind, "unknown", failure);
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
              batchSteps.push(receipt);
              receipts.push(receipt);
              await deps.onActionFinished?.(eventIndex, action.kind, outcome, receipt.error);
              if (outcome === "delivered" || outcome === "satisfied") {
                // A local wait may have observed an externally changed frame;
                // treat the facade call as observation-dirty so the final
                // result does not reuse a pre-wait snapshot.
                mutationsSinceObservation++;
                continue;
              }
              if (outcome === "unknown") markUnknownDelivery();
              batchStatus = outcome === "unknown" || result.status === "interrupted" ? "interrupted" : "failed";
              break;
            }
            if (batchStatus === "completed" && request.observe !== undefined) {
              try {
                const observation = (await deps.driverCall("observe", { options: request.observe })) as Observation;
                observations.push(observation);
                scriptObserved = true;
                mutationsSinceObservation = 0;
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
          await deps.onActionStarted?.(index, kind);
          let single: BatchRequest;
          try {
            single = validateBatch(singleActionBatch(method, rpcArgs));
          } catch (error) {
            const validationError = {
              code: "batch_request_invalid",
              message: error instanceof Error ? error.message : String(error)
            };
            receipts.push({ index, kind, status: "not_delivered", error: validationError });
            await deps.onActionFinished?.(index, kind, "not_delivered", validationError);
            throw new ComputerError(validationError.code, validationError.message, "not_delivered");
          }
          let result: { status: string; steps?: ActionReceipt[] };
          try {
            result = (await deps.driverCall("batch", { request: single })) as {
              status: string;
              steps?: ActionReceipt[];
            };
          } catch (error) {
            // The native mutation crossed the host boundary. A missing or
            // unclassified response is never an ordinary script failure.
            markUnknownDelivery();
            await deps.onActionFinished?.(index, kind, "unknown", {
              code: error instanceof ComputerError ? error.code : "action_failed",
              message: error instanceof Error ? error.message : String(error)
            });
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
          await deps.onActionFinished?.(index, kind, status, receipt.error);
          receipts.push(receipt);
          if (status === "delivered" || status === "satisfied") {
            mutationsSinceObservation++;
            return null;
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
        if (!(error instanceof ComputerError)) {
          receipts.push({
            index,
            kind: method as ActionReceipt["kind"],
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
        const value = message.value as JsonValue;
        const candidateState = message.state as Record<string, JsonValue>;
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
        if (runLimitError) {
          finish({
            status: "failed",
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
          validateJsonValue(candidateState, 256 * 1024);
          const candidate: ExecResult = {
            status: "completed",
            value,
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
            pendingCommit = { value, state: candidateState, result: candidate };
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
        const error = message.error as { code: string; message: string };
        logs = (message.logs as string[]) ?? [];
        finish({
          status: runUnknownDelivery ? "unknown" : "failed",
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
        logs = (message.logs as string[]) ?? [];
        finish({
          status: runUnknownDelivery ? "unknown" : "failed",
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
  (child.stdio[3] as import("node:stream").Readable | null)?.on("data", (chunk: Buffer) => {
    let frames: string[];
    try {
      frames = controlReader.push(chunk);
    } catch {
      // Oversized/malformed control frame: treat as a protocol failure and
      // reclaim the worker.
      admissionClosed = true;
      void stopProcessGroup(child, TERM_GRACE_MS);
      return;
    }
    for (const line of frames) {
      if (line.trim() !== "") handleWorkerLine(line);
    }
  });

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
    const deadline = Date.now() + options.timeoutMs + TERM_GRACE_MS + 5_000;
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
    clearTimeout(watchdog);
    signal?.removeEventListener("abort", onAbort);
    admissionClosed = true;
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
      if (terminal.result) {
        terminal.result.status = "unknown";
        terminal.result.error = {
          code: "worker_group_unclean",
          message: `the script ended but its process group could not be fully reclaimed (survivors: pgid ${stop.groupSurvivors})`
        };
      }
    }
    // Settle the in-flight native dispatch (F3): the terminal state must not
    // leave native work executing behind an idle session.
    if (inFlightNative !== null) {
      const settleDeadline = Date.now() + NATIVE_SETTLE_MS;
      while (inFlightNative !== null && Date.now() < settleDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (inFlightNative !== null && terminal.result) {
        nativeDispatchUnresolved = true;
        terminal.result.status = "unknown";
        terminal.result.error = {
          code: "native_in_flight",
          message: "a native dispatch was still executing when the request ended — delivery state is unknown; the session must not reuse the driver"
        };
      }
    }
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
    if (observations.length >= EXEC_MAX_OBSERVATIONS) {
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
        const finalNative = Promise.resolve().then(() => deps.finalObserve());
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
          result.observations.push(final);
          scriptObserved = true;
          mutationsSinceObservation = 0;
        } catch (error) {
          result.status = "failed";
          result.error = {
            code: "final_observe_failed",
            message: error instanceof Error ? error.message : String(error)
          };
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
              result.error = {
                code: "native_in_flight",
                message: "the final observation was still executing when the request ended — delivery state is unknown"
              };
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
    try {
      await deps.onStateCommitIntent?.({
        expectedVersion: stateBefore.version,
        version: stateBefore.version + 1,
        hash
      });
      stateVersion = commitExecState(deps.stateDir, stateBefore.version, pendingCommit.state);
      result.stateVersion = stateVersion;
      result.stateCommitted = true;
      result.stateHash = hash;
    } catch (error) {
      result.status = "failed";
      result.stateCommitted = false;
      result.error = {
        code: "state_commit_failed",
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }
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
