// Session host (B2/B3): the single local owner of one desktop target. It
// listens on the private session socket, keeps the driver worker in a
// dedicated process, dedupes requests through the request ledger,
// holds the application-level target lease, and stays responsive for
// status/cancel/close while a business operation is running. Hosted exec
// state and terminal results share an immutable transaction commit.
//
// Ownership rules (review findings 2/3/5): a session only releases its
// target lease when the driver worker is PROVEN terminated (state "closed").
// Unknown delivery, an un-reclaimable driver, or a still-settling native
// call keep the lease and the socket: callers observe "unusable" instead of
// a vanished session guessing. The lease owner also records live worker
// pids, so a crashed host with a surviving detached driver is NOT
// reclaimable until that worker is gone.

import { createServer, type Server, type Socket } from "node:net";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  acquireTargetLease,
  canonicalRequestHash,
  ComputerError,
  createRequestJournal,
  createRequestLedger,
  createExecutionScope,
  validateBatch,
  DEFAULT_BATCH_TIMEOUT_MS,
  processStartTime,
  type LeaseHandle,
  type RequestOutcome,
  type RequestJournal
} from "@ya-skills/computer-runtime";
import {
  decodeRequest,
  encodeControl,
  FrameReader
} from "./protocol.js";
import type {
  SessionControl,
  SessionControlReply,
  SessionInfo,
  SessionReply,
  SessionRequest,
  SessionState
} from "./types.js";
import { assertSocketPathLength, sessionPaths, validateSessionId } from "./paths.js";
import type { StopResult } from "./process.js";
import type { DriverMethod } from "./driver-worker.js";
import { buildHostDriver } from "./host-driver.js";
import type { DriverHandle, HostConfig } from "./host-types.js";
import { executeHostedBatch as runHostedBatch } from "./host-batch.js";
import {
  classifyExecStateCommit,
  createExecStateRecovery,
  type StateCommitDisposition
} from "./host-recovery.js";

export const MAX_IDLE_TIMEOUT_MS = 120_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
/** Bounded wait for an in-flight business call during shutdown. */
const SHUTDOWN_INFLIGHT_BUDGET_MS = 10_000;
/** Bounded wait for a `close` control to observe the final state. */
const CLOSE_CONTROL_BUDGET_MS = 10_000;

// ---- host -----------------------------------------------------------------

export interface Host {
  info(): SessionInfo;
  socketPath(): string;
  close(): Promise<SessionInfo>;
  waitUntilClosed(): Promise<SessionInfo>;
  /** Resolves when the control listener is explicitly or normally closed. */
  waitUntilListenerClosed(): Promise<void>;
}

export interface HostDeps {
  driver?: "subprocess" | "in-process";
  lease?: (config: HostConfig) => Promise<LeaseHandle>;
  journal?: (config: HostConfig) => RequestJournal;
  diagnostics?: () => Record<string, unknown>;
}

export interface CleanupReport {
  /** Driver worker exit was confirmed by the group-level stop. */
  driverTerminated: boolean;
  /** The target lease was released (only ever true for state "closed"). */
  leaseReleased: boolean;
  /** Requests that ended without a confirmed terminal state. */
  unresolvedRequests: string[];
}

export type { DriverHandle, HostConfig } from "./host-types.js";

export async function startHost(config: HostConfig, deps: HostDeps = {}): Promise<Host> {
  validateSessionId(config.sessionId);
  assertSocketPathLength(config.socketPath);
  const idleTimeoutMs = Math.min(config.idleTimeoutMs || DEFAULT_IDLE_TIMEOUT_MS, MAX_IDLE_TIMEOUT_MS);
  const state: { value: SessionState } = { value: "starting" };
  const paths = sessionPaths(config.root, config.sessionId);
  mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  // Per-session state (F7): script state NEVER crosses session boundaries.
  const stateDir = join(paths.directory, "state");

  // Production configs are written with this UUID-specific path. Deriving it
  // here too prevents a malformed/stale config from accidentally sharing
  // request records with another session; tests may still inject a journal.
  const journal = deps.journal?.(config) ?? createRequestJournal(join(paths.directory, "requests"));

  let activeRequestId: string | undefined;
  const { ledger: stateLedger, validateLedgerTransaction, validateRecoveredExecState, validateStateBeforeAdmission } = createExecStateRecovery(
    stateDir,
    journal,
    () => activeRequestId
  );
  let inFlight: { requestId: string; abort: Pick<AbortController, "signal" | "abort"> } | null = null;
  let deliveries = 0;
  const requests = createRequestLedger(journal);
  const liveExecWorkers = new Set<number>();
  /** Process groups retained after failed worker cleanup. This survives host
   * death through the lease record and blocks unsafe target reclamation. */
  const unresolvedWorkerGroups = new Map<number, { pgid: number; leaderPid: number }>();
  let cleanupUnproven = false;
  let idleTimer: NodeJS.Timeout | null = null;
  let server: Server | null = null;
  /** Admission closes as soon as shutdown starts; `finalized` is separate so
   * waitUntilClosed and hostMain never mistake a transient `stopping` state
   * for confirmed cleanup. */
  let closed = false;
  let finalized = false;
  let shutdownPromise: Promise<SessionInfo> | null = null;
  /** Deferred teardown that must wait until the business reply is written. */
  let afterReply: (() => void) | null = null;
  const closeWaiters: ((info: SessionInfo) => void)[] = [];
  const listenerCloseWaiters: (() => void)[] = [];
  let listenerClosed = false;
  let closeRequested = false;
  const appendJournalEvent = requests.append;

  const driverMode = deps.driver ?? (config.inProcessDriver ? "in-process" : "subprocess");

  // Acquire ownership BEFORE starting/initializing the driver. A rejected
  // target must not leave a detached native worker behind, and a successful
  // claim can conservatively record that worker as it starts.
  const lease: LeaseHandle =
    deps.lease !== undefined
      ? await deps.lease(config)
      : await acquireTargetLease(
          config.root,
          { pid: config.target.pid, windowId: BigInt(config.target.windowId) },
          {
            generation: config.generation,
            pid: process.pid,
            processStart: processStartTimeCached(),
            sessionId: config.sessionId,
            kind: "session"
          }
        );
  let driver: DriverHandle;
  try {
    driver = await buildHostDriver(config, driverMode, () => undefined);
  } catch (error) {
    await lease.release().catch(() => undefined);
    throw error;
  }
  // The lease records every live worker pid, so a dead host with a surviving
  // detached driver can never be silently reclaimed (F2). Refresh is checked
  // below as a lifecycle failure rather than being silently ignored.
  const driverPid = driver.pid();
  let leaseHealthy = true;
  if (driverPid !== null) {
    try {
      await lease.refreshOwner({ workerPids: [driverPid] });
    } catch (error) {
      const stop = await driver.stop().catch(() => ({ exited: false } as StopResult));
      // A failed owner refresh must not release a lease while the detached
      // worker might still be alive; retain the lease and report the host as
      // unusable until an operator can establish termination.
      if (!stop.exited) leaseHealthy = false;
      if (stop.exited) await lease.release().catch(() => undefined);
      throw error;
    }
  }

  const refreshLease = async (pids: number[]): Promise<void> => {
    try {
      await lease.refreshOwner({
        workerPids: pids,
        workerGroups: [...unresolvedWorkerGroups.values()].map((group) => ({ pgid: group.pgid, leaderPid: group.leaderPid })),
        cleanupUnproven
      });
    } catch (error) {
      leaseHealthy = false;
      state.value = "unusable";
      throw error;
    }
  };
  const leasePatch = () => ({
    workerPids: [...(driverPid !== null ? [driverPid] : []), ...liveExecWorkers],
    workerGroups: [...unresolvedWorkerGroups.values()].map((group) => ({ pgid: group.pgid, leaderPid: group.leaderPid }))
  });
  const registerExecWorker = async (pid: number | null): Promise<void> => {
    if (pid === null) return;
    liveExecWorkers.add(pid);
    await refreshLease(leasePatch().workerPids);
  };
  const unregisterExecWorker = async (pid: number | null): Promise<void> => {
    if (pid === null) return;
    liveExecWorkers.delete(pid);
    try {
      await lease.refreshOwner(leasePatch());
    } catch {
      // The worker is already gone; keep the lease and let the host report an
      // unusable cleanup state rather than losing the worker identity.
      state.value = "unusable";
    }
  };
  const recordExecWorkerCleanupFailure = async (pid: number | null, pgid: number | null): Promise<void> => {
    if (pid === null || pgid === null) {
      cleanupUnproven = true;
      state.value = "unusable";
      await refreshLease(driverPid !== null ? [driverPid, ...liveExecWorkers] : [...liveExecWorkers]);
      throw new Error("worker cleanup failed without a verifiable process-group identity");
    }
    unresolvedWorkerGroups.set(pid, { pgid, leaderPid: pid });
    liveExecWorkers.add(pid);
    try {
      await refreshLease(leasePatch().workerPids);
    } catch (error) {
      cleanupUnproven = true;
      // Retry with an explicit durable poison bit. If the lease file is
      // unreadable or held by an unknown updater, the host remains unusable
      // and the existing owner is never released.
      await lease.refreshOwner({
        workerPids: leasePatch().workerPids,
        workerGroups: leasePatch().workerGroups,
        cleanupUnproven: true
      }).catch(() => undefined);
      throw error;
    }
    state.value = "unusable";
  };

  const terminateBeforeUnknownReply = async (): Promise<void> => {
    try {
      const stop = await driver.stop();
      if (!stop.exited) leaseHealthy = false;
    } catch (error) {
      leaseHealthy = false;
      console.error("[host] could not terminate the driver before reporting unknown delivery:", error instanceof Error ? error.message : error);
    }
  };

  const info = (): SessionInfo => ({
    id: config.sessionId,
    target: { ...config.target },
    state: state.value,
    ...(activeRequestId !== undefined ? { activeRequestId } : {}),
    hostPid: process.pid,
    generation: config.generation,
    idleTimeoutMs
  });

  const writeMetadata = () => {
    try {
      writeFileSync(paths.metadata, JSON.stringify(info(), null, 2), { mode: 0o600 });
    } catch {
      // metadata is a discovery cache, not the SSOT
    }
  };

  const clearIdle = () => {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const scheduleIdle = () => {
    clearIdle();
    if (closed || inFlight !== null) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (inFlight === null && !closed) {
        void shutdown(`idle-timeout-${idleTimeoutMs}ms`);
      }
    }, idleTimeoutMs);
    idleTimer.unref();
  };

  const closeSocket = (): void => {
    if (server !== null) {
      server.close();
      server = null;
    }
    listenerClosed = true;
    for (const waiter of listenerCloseWaiters.splice(0)) waiter();
    try {
      rmSync(config.socketPath, { force: true });
    } catch {
      // best effort
    }
  };

  let leaseReleased = false;
  const shutdown = (reason: string, force = false): Promise<SessionInfo> => {
    if (shutdownPromise) return shutdownPromise;
    // Admission closes synchronously, but callers waiting for closure must
    // wait for the async driver/group cleanup and final metadata write.
    closed = true;
    shutdownPromise = (async (): Promise<SessionInfo> => {
      // An "unusable" verdict (unknown delivery) survives the shutdown flow.
      const markedUnusable = state.value === "unusable";
      state.value = "stopping";
      clearIdle();
      closeIdleSockets();
      if (force && inFlight !== null) {
        inFlight.abort.abort();
      }
      // Wait (bounded) for an in-flight business call before stopping driver.
      const inflightDeadline = Date.now() + SHUTDOWN_INFLIGHT_BUDGET_MS;
      while (inFlight !== null && Date.now() < inflightDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      let stopResult: StopResult;
      try {
        stopResult = await driver.stop();
      } catch (error) {
        leaseHealthy = false;
        state.value = "unusable";
        stopResult = {
          exited: false,
          signal: null,
          code: null,
          groupSurvivors: driverPid
        };
        console.error(`[host] driver cleanup failed (${reason}):`, error instanceof Error ? error.message : error);
      }
      if (!stopResult.exited) {
        if (driverPid !== null && stopResult.groupSurvivors !== null) {
          unresolvedWorkerGroups.set(driverPid, { pgid: stopResult.groupSurvivors, leaderPid: driverPid });
          liveExecWorkers.add(driverPid);
          try {
            await refreshLease([...liveExecWorkers]);
          } catch {
            cleanupUnproven = true;
            await lease.refreshOwner({
              workerPids: [...liveExecWorkers],
              workerGroups: [...unresolvedWorkerGroups.values()].map((group) => ({ pgid: group.pgid, leaderPid: group.leaderPid })),
              cleanupUnproven: true
            }).catch(() => undefined);
          }
        } else {
          cleanupUnproven = true;
          try {
            await lease.refreshOwner({ cleanupUnproven: true });
          } catch {
            leaseHealthy = false;
          }
        }
      }
      // Un-reclaimable driver, unresolved request, or unknown delivery: the
      // session is unusable and the LEASE IS KEPT — reclamation requires proof
      // that no native work survives (F2). The lease owner keeps the worker
      // pids/groups recorded, so even a dead host with a surviving driver blocks.
      if (markedUnusable || !leaseHealthy || !stopResult.exited || inFlight !== null || cleanupUnproven) {
        state.value = "unusable";
      } else {
        state.value = "closed";
      }
      if (inFlight !== null) {
        const outcome = requests.cached(inFlight.requestId) ?? {
          status: "unknown" as const,
          error: { code: "session_closing", message: `session closed (${reason}) with the request in flight` }
        };
        if (outcome.status !== "completed") {
          requests.fail(inFlight.requestId, outcome.error);
          try {
            await recordOutcome(inFlight.requestId, { status: "unknown", error: outcome.error });
          } catch {
            // The session remains unusable and the failed terminal append is
            // intentionally not replaced with a guessed success.
          }
        }
        inFlight = null;
      }
      if (state.value === "closed") {
        try {
          await lease.release();
          leaseReleased = true;
        } catch {
          state.value = "unusable";
        }
      }
      // Unknown delivery retains the lease and the queryable control plane.
      // Only normal closure or an explicit close request ends the listener.
      if (state.value === "closed" || closeRequested) closeSocket();
      writeMetadata();
      finalized = true;
      const final = info();
      for (const waiter of closeWaiters.splice(0)) waiter(final);
      return final;
    })();
    return shutdownPromise;
  };

  const recordOutcome = async (
    requestId: string,
    outcome: RequestOutcome,
    stateCommitDisposition?: StateCommitDisposition
  ): Promise<boolean> => {
    // A terminal reply is not published until its terminal event is durable.
    // If persistence fails after input was dispatched, fail closed and keep
    // the target unusable rather than claiming a recoverable success.
    try {
      await requests.finish(requestId, outcome, {
        ...(stateCommitDisposition !== undefined ? { stateCommitDisposition } : {})
      });
    } catch (error) {
      // A committed transaction already durably owns the result. Failure of
      // the compatibility journal cannot turn that commit into unknown.
      try {
        const committed = stateLedger.read(requestId);
        if (committed && validateLedgerTransaction(requestId)) {
          requests.acceptCommitted(requestId, { status: committed.status, result: committed.result });
          return true;
        }
      } catch { /* Fall through to fail closed when no valid commit exists. */ }
      const message = error instanceof Error ? error.message : String(error);
      state.value = "unusable";
      requests.fail(requestId, {
        code: "journal_error", message: `could not persist terminal request outcome: ${message}`
      });
      return false;
    }
    return true;
  };

  const runBusiness = async (request: SessionRequest): Promise<SessionReply> => {
    // One request deadline starts before claim/journal work. Native calls and
    // final evidence receive only the remaining portion of this budget.
    const requestStartedAt = Date.now();
    const rawTimeout = request.operation.kind === "batch"
      ? request.operation.request.timeoutMs
      : request.operation.kind === "exec"
        ? request.operation.timeoutMs
        : undefined;
    const requestTimeoutMs = typeof rawTimeout === "number" && Number.isSafeInteger(rawTimeout) && rawTimeout > 0
      ? rawTimeout
      : request.operation.kind === "exec" ? 60_000 : DEFAULT_BATCH_TIMEOUT_MS;
    // Observation requests have no public timeout field, but they still need
    // a bounded native read. A persistent driver must receive the same
    // request-local abort signal as batch/exec calls rather than resetting its
    // deadline at the observation seam.
    const requestDeadlineAt = requestStartedAt + requestTimeoutMs;
    const complete = async (
      outcome: RequestOutcome,
      noun = "request",
      disposition?: StateCommitDisposition,
      unusable = outcome.status === "unknown"
    ): Promise<SessionReply> => {
      if (outcome.status === "unknown") await terminateBeforeUnknownReply();
      if (!await recordOutcome(request.requestId, outcome, disposition)) {
        state.value = "unusable";
        afterReply = () => void shutdown("journal-failure", false);
        return {
          schemaVersion: 1, requestId: request.requestId, status: "unknown",
          error: { code: "journal_error", message: `terminal ${noun} outcome could not be persisted; delivery is unknown` }
        };
      }
      if (unusable) {
        state.value = "unusable";
        afterReply = () => void shutdown("unknown-delivery", false);
      }
      return { schemaVersion: 1, requestId: request.requestId, ...outcome };
    };
    // 1. dedup FIRST (before busy): same id returns the recorded outcome.
    const hash = canonicalRequestHash({
      kind: request.operation.kind,
      target: config.target,
      operation: request.operation
    });
    // The transaction is authoritative even when its legacy request directory
    // is missing. Check it before claiming or consulting the live cache.
    try {
      const committed = stateLedger.read(request.requestId);
      if (committed !== undefined) {
        if (committed.requestHash !== hash) {
          return errorReply(request, "request_conflict", `request ${request.requestId} was used with different content`);
        }
        if (!validateLedgerTransaction(request.requestId, hash)) throw new Error("the committed request/state record is not verifiable");
        return { schemaVersion: 1, requestId: request.requestId, status: committed.status, result: committed.result };
      }
    } catch (error) {
      state.value = "unusable";
      return {
        schemaVersion: 1, requestId: request.requestId, status: "unknown",
        error: { code: "state_recovery_mismatch", message: error instanceof Error ? error.message : String(error) }
      };
    }
    let claim: "new" | "existing" | "conflict";
    try {
      claim = await requests.claim(request.requestId, hash);
    } catch (error) {
      return errorReply(request, "journal_error", error instanceof Error ? error.message : String(error));
    }
    if (claim === "conflict") {
      return errorReply(request, "request_conflict", `request ${request.requestId} was used with different content`);
    }
    if (claim === "existing") {
      const prior = requests.cached(request.requestId);
      if (prior) {
        return { schemaVersion: 1, requestId: request.requestId, status: prior.status, ...(prior.result !== undefined ? { result: prior.result } : {}), ...(prior.error ? { error: prior.error } : {}) };
      }
      let record;
      try {
        record = await requests.read(request.requestId);
      } catch {
        return errorReply(request, "journal_error", "request record is unreadable");
      }
      if (record.status === "running") {
        // The request is already claimed by this or a previous host. A
        // duplicate is a status query, never a second dispatch.
        return { schemaVersion: 1, requestId: request.requestId, status: "running" };
      }
      const hasCommitIntent = record.events.some((event) => event.type === "state_commit_intent");
      if (request.operation.kind === "exec" && (hasCommitIntent || record.result !== undefined) && !validateRecoveredExecState(record, request.requestId)) {
        state.value = "unusable";
        return {
          schemaVersion: 1,
          requestId: request.requestId,
          status: "unknown",
          error: {
            code: "state_recovery_mismatch",
            message: hasCommitIntent
              ? "the recorded exec state commit history is not verifiable; refusing to replay"
              : "the recorded exec state commit does not match state.json; refusing to replay"
          }
        };
      }
      if (record.result !== undefined) {
        // Durable recovery of any terminal result (F8): the events file is
        // the SSOT — a recorded outcome is returned, never rerun. A committed
        // exec state must also agree with its intent/version/hash linkage.
        return { schemaVersion: 1, requestId: request.requestId, status: record.status, result: record.result };
      }
      return { schemaVersion: 1, requestId: request.requestId, status: "unknown", error: { code: "batch_not_replayed", message: `prior run ended ${record.status}; observe instead of replaying` } };
    }
    // 2. A NEW request is durably classified before it can be rejected. This
    // avoids leaving a claimed id in a forever-running state when admission is
    // busy, closed, or the generation is stale. State/journal recovery is
    // checked before an idle session accepts another desktop mutation.
    const admissionError =
      inFlight !== null
        ? { code: "session_busy", message: "another request is running on this session" }
        : closed || state.value !== "idle"
          ? { code: "session_closed", message: `session is ${state.value}` }
          : request.generation !== config.generation
            ? { code: "stale_generation", message: "request targets an older session generation" }
            : null;
    const rejectAdmission = async (error: { code: string; message: string }): Promise<SessionReply> => {
      try {
        // Rejected requests still get a durable terminal record, but they do
        // not reserve the active slot and never reach the driver.
        await appendJournalEvent(request.requestId, "request_started", { kind: request.operation.kind });
        await recordOutcome(request.requestId, { status: "failed", error });
      } catch (error) {
        state.value = "unusable";
        requests.fail(request.requestId, {
          code: "journal_error", message: error instanceof Error ? error.message : String(error)
        });
      }
      return errorReply(request, error.code, error.message);
    };
    if (admissionError) return rejectAdmission(admissionError);
    // 3. Reserve synchronously BEFORE the first post-admission await. A
    // single socket data event may contain two business frames; once this
    // slot is assigned, the second frame observes session_busy even while the
    // first request's request_started append is awaiting durability.
    const requestAbort = createExecutionScope({ deadlineAt: requestDeadlineAt });
    activeRequestId = request.requestId;
    inFlight = { requestId: request.requestId, abort: requestAbort };
    state.value = "running";
    clearIdle();
    let stateAdmissionError: { code: string; message: string } | null = null;
    try {
      await validateStateBeforeAdmission();
    } catch (error) {
      stateAdmissionError = {
        code: "state_recovery_mismatch",
        message: error instanceof Error ? error.message : String(error)
      };
      state.value = "unusable";
    }
    if (stateAdmissionError !== null) {
      const reply = await rejectAdmission(stateAdmissionError);
      inFlight = null;
      activeRequestId = undefined;
      requestAbort.dispose();
      return reply;
    }
    try {
      // 4. persist the start BEFORE dispatch (F8): a persistence failure
      // fails the request closed — desktop input never outruns its journal.
      await appendJournalEvent(request.requestId, "request_started", { kind: request.operation.kind });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.value = "unusable";
      requests.fail(request.requestId, { code: "journal_error", message });
      inFlight = null;
      activeRequestId = undefined;
      requestAbort.dispose();
      return errorReply(request, "journal_error", `could not persist the request start — nothing was dispatched: ${message}`);
    }
    // 5. execute through the driver, exactly once. The request-local timer is
    // the deadline propagation path for a persistent driver: its observe
    // method receives this signal instead of silently resetting to a fresh
    // per-call budget.
    if (request.operation.kind === "observe") {
      requestAbort.onDeadline(() => requestAbort.abort(new Error("request deadline exceeded")));
    }
    let validatedBatchRequest: ReturnType<typeof validateBatch> | null = null;
    const finishedBatchActions = new Set<number>();
    try {
      if (request.operation.kind === "batch") {
        try {
          validatedBatchRequest = validateBatch(request.operation.request);
        } catch (error) {
          throw new ComputerError(
            "batch_request_invalid",
            error instanceof Error ? error.message : String(error),
            "not_delivered"
          );
        }
        const batch = await runHostedBatch(
          driver,
          appendJournalEvent,
          request.requestId,
          validatedBatchRequest,
          requestAbort.signal,
          requestDeadlineAt,
          finishedBatchActions
        );
        const batchSteps = batch.steps as Array<{ status?: unknown }>;
        const sawUnknownStep = batchSteps.some((step) => step.status === "unknown");
        const status: SessionReply["status"] = sawUnknownStep
          ? "unknown"
          : batch.status === "completed"
            ? "completed"
            : batch.status;
        deliveries += batchSteps.filter((step) => step.status === "delivered" || step.status === "satisfied").length;
        const batchResult = {
          ...batch,
          ...(batch.observation !== undefined ? { observation: batch.observation } : {})
        };
        const unknownStep = batchSteps.find((step) => step.status === "unknown") as { error?: { code?: string; message?: string } } | undefined;
        const batchError = status === "unknown"
          ? {
              code: typeof unknownStep?.error?.code === "string" ? unknownStep.error.code : "unknown_delivery",
              message: typeof unknownStep?.error?.message === "string" ? unknownStep.error.message : "batch delivery could not be confirmed"
            }
          : undefined;
        return await complete({
          status,
          result: batchResult,
          ...(batchError !== undefined ? { error: batchError } : {})
        }, "batch");
      }
      if (request.operation.kind === "exec") {
        // Exec: disposable script worker + host-generated receipts + state
        // commit only on clean completion (C1/C2/C3).
        const { runExec, normalizeExecOptions } = await import("./exec-runner.js");
        const options = normalizeExecOptions(request.operation as { code: unknown; sourceName: unknown; timeoutMs: unknown; maxActions: unknown });
        const result = await runExec(
          {
            sessionId: config.sessionId,
            generation: config.generation,
            target: { pid: config.target.pid, windowId: BigInt(config.target.windowId) },
            stateDir,
            driverCall: (method, args, signal) => driver.call(method, args, signal ?? requestAbort.signal),
            driverSupportsStep: driver.supportsStep,
            finalObserve: async (signal, deadlineAt) => {
              if (!driver.alive()) return null;
              // Errors propagate: the runner must be able to report
              // final_observe_failed instead of silently omitting the
              // observation (F14). The absolute execution deadline follows
              // the call into the persistent driver session as well.
              return (await driver.call(
                "observe",
                {
                  options: { mode: "auto" },
                  ...(deadlineAt !== undefined ? { deadlineAt } : {})
                },
                signal ?? requestAbort.signal
              )) as never;
            },
            onExecWorkerSpawn: registerExecWorker,
            onExecWorkerExit: unregisterExecWorker,
            onExecWorkerCleanupFailed: recordExecWorkerCleanupFailure,
            onActionStarted: async (index, kind) => {
              try {
                await appendJournalEvent(request.requestId, "action_started", { index, kind });
              } catch (error) {
                state.value = "unusable";
                throw new ComputerError(
                  "journal_error",
                  `could not persist action start before dispatch: ${error instanceof Error ? error.message : String(error)}`,
                  "not_delivered"
                );
              }
            },
            onActionFinished: async (index, kind, outcome, error) => {
              try {
                await appendJournalEvent(request.requestId, "action_finished", {
                  index,
                  kind,
                  outcome,
                  ...(error !== undefined ? { error } : {})
                });
              } catch (journalError) {
                state.value = "unusable";
                throw new ComputerError(
                  "journal_error",
                  `could not persist action outcome: ${journalError instanceof Error ? journalError.message : String(journalError)}`,
                  "unknown"
                );
              }
            },
            onStateCommitIntent: async (intent) => {
              await appendJournalEvent(request.requestId, "state_commit_intent", {
                requestId: request.requestId,
                expectedVersion: intent.expectedVersion,
                version: intent.version,
                stateHash: intent.hash
              });
            },
            commitState: (expectedVersion, candidate, result) => stateLedger.commitState(
              request.requestId, hash, expectedVersion, candidate, result
            ),
            deadlineAt: requestDeadlineAt
          },
          request.requestId,
          options,
          inFlight.abort.signal
        );
        deliveries += result.actions.filter((a) => a.status === "delivered" || a.status === "satisfied").length;
        const status: SessionReply["status"] =
          result.status === "completed" ? "completed" : result.status === "interrupted" ? "interrupted" : result.status === "unknown" ? "unknown" : "failed";
        return await complete({ status, result }, "exec", classifyExecStateCommit(result));
      }
      const method: DriverMethod = request.operation.kind;
      const args = { options: request.operation.options, deadlineAt: requestDeadlineAt };
      const result = await driver.call(method, args as Record<string, unknown>, requestAbort.signal);
      // A persistent driver may finish an observe after it noticed (or
      // ignored) cancellation. Recheck at the publication seam so a late
      // result cannot be recorded as a successful direct observation.
      if (requestAbort.signal.aborted || Date.now() >= requestDeadlineAt) {
        throw new ComputerError(
          requestAbort.signal.aborted ? "request_cancelled" : "command_timeout",
          requestAbort.signal.aborted
            ? "the observation was cancelled before completion was published"
            : "the observation deadline expired before completion was published"
        );
      }
      return await complete({ status: "completed", result: result ?? null });
    } catch (error) {
      const code = error instanceof ComputerError ? error.code : "request_failed";
      const message = error instanceof Error ? error.message : String(error);
      const observationInterrupted = request.operation.kind === "observe" &&
        (code === "aborted" || code === "request_cancelled" || code === "command_timeout");
      const status: SessionReply["status"] =
        (error instanceof ComputerError && error.actionOutcome === "unknown") || (!observationInterrupted && isUnknownDelivery(code))
          ? "unknown"
          : observationInterrupted
            ? "interrupted"
            : "failed";
      // A batch call that throws after dispatch has no returned receipts. Its
      // planned actions are therefore conservatively marked unknown before
      // the terminal request event is written.
      if (validatedBatchRequest !== null) {
        for (const [index, action] of validatedBatchRequest.actions.entries()) {
          if (finishedBatchActions.has(index)) continue;
          try {
            await appendJournalEvent(request.requestId, "action_finished", {
              index,
              kind: action.kind,
              outcome: status === "unknown" ? "unknown" : "not_delivered",
              error: { code, message }
            });
            finishedBatchActions.add(index);
          } catch {
            state.value = "unusable";
          }
        }
      }
      return await complete(
        { status, error: { code, message } }, "request", undefined,
        !observationInterrupted && isUnknownDelivery(code)
      );
    } finally {
      requestAbort.dispose();
      inFlight = null;
      activeRequestId = undefined;
      if (state.value === "running") state.value = "idle";
      if (!closed) {
        scheduleIdle();
        writeMetadata();
      }
    }
  };

  const isUnknownDelivery = (code: string): boolean =>
    ["command_timeout", "action_failed", "driver_worker_exited", "session_unusable"].includes(code);

  const errorReply = (request: Pick<SessionRequest, "requestId">, code: string, message: string): SessionReply => ({
    schemaVersion: 1,
    requestId: request.requestId,
    status: "failed",
    error: { code, message }
  });

  const idleSockets = new Set<Socket>();
  /** A client may send multiple business frames in one chunk. Keep the
   * connection open until every frame already accepted has a reply; ending it
   * from the first handler would silently drop later receipts. */
  const pendingSocketReplies = new Map<Socket, number>();
  const closeIdleSockets = () => {
    for (const socket of idleSockets) socket.destroy();
    idleSockets.clear();
    pendingSocketReplies.clear();
  };

  // Host-level diagnostics: driver init count, delivered mutation count, and
  // the REAL live exec-worker count (F23 — never a hardcoded 0).
  const hostDiagnostics = (): Record<string, unknown> => ({
    driverInitCount: driver.initCount,
    deliveries,
    liveExecWorkers: liveExecWorkers.size,
    liveExecWorkerPids: [...liveExecWorkers]
  });

  server = createServer((socket) => {
    const reader = new FrameReader();
    socket.on("data", (chunk: Buffer) => {
      let frames: string[];
      try {
        frames = reader.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const line of frames) handleLine(socket, line);
    });
    socket.on("error", () => socket.destroy());
  });

  const handleLine = (socket: Socket, line: string) => {
    // Parse once and discriminate the top-level control tag. Searching the
    // raw JSON for `kind":"status` lets an exec script containing that text
    // hijack the control plane.
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      socket.write(encodeControl({ schemaVersion: 1, error: { code: "protocol_json", message: "frame is not JSON" } }));
      return;
    }
    const topKind =
      typeof parsed === "object" && parsed !== null && typeof (parsed as { kind?: unknown }).kind === "string"
        ? (parsed as { kind: string }).kind
        : undefined;
    if (topKind === "status" || topKind === "cancel" || topKind === "close" || topKind === "diagnostics") {
      const control = parsed as SessionControl | { kind: "diagnostics"; schemaVersion: 1; sessionId: string };
      void Promise.resolve(handleControl(control)).then((reply) => {
        socket.write(encodeControl(reply));
        if (reply.info?.state === "closed" || reply.info?.state === "unusable") {
          socket.end(() => {
            if (control.kind === "close" && finalized) closeSocket();
          });
        }
      });
      return;
    }
    let request: SessionRequest;
    try {
      request = decodeRequest(line);
    } catch (error) {
      socket.write(
        encodeControl({
          schemaVersion: 1,
          error: { code: error instanceof Error ? error.message.slice(0, 64) : "protocol_error", message: error instanceof Error ? error.message : String(error) }
        })
      );
      return;
    }
    if (request.sessionId !== config.sessionId) {
      socket.write(
        `${JSON.stringify({
          schemaVersion: 1,
          requestId: request.requestId,
          status: "failed",
          error: { code: "unknown_session", message: "request targets a different session" }
        })}\n`
      );
      return;
    }
    idleSockets.add(socket);
    pendingSocketReplies.set(socket, (pendingSocketReplies.get(socket) ?? 0) + 1);
    const finishSocketReply = (): void => {
      const remaining = (pendingSocketReplies.get(socket) ?? 1) - 1;
      if (remaining <= 0) {
        pendingSocketReplies.delete(socket);
        idleSockets.delete(socket);
        socket.end();
      } else {
        pendingSocketReplies.set(socket, remaining);
      }
    };
    void runBusiness(request)
      .then((reply) => {
        socket.write(`${JSON.stringify(reply, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}\n`);
        finishSocketReply();
        const hook = afterReply;
        afterReply = null;
        hook?.();
      })
      .catch((error) => {
        socket.write(
          `${JSON.stringify(errorReply(request, "host_error", error instanceof Error ? error.message : String(error)))}\n`
        );
        finishSocketReply();
      });
  };

  const handleControl = async (
    control: SessionControl | { kind: "diagnostics"; schemaVersion: 1; sessionId: string }
  ): Promise<SessionControlReply> => {
    if (control.schemaVersion !== 1) {
      return { schemaVersion: 1, error: { code: "protocol_version", message: "unsupported control schemaVersion" } };
    }
    if (typeof control.sessionId !== "string" || control.sessionId !== config.sessionId) {
      return { schemaVersion: 1, error: { code: "unknown_session", message: "control targets a different session" } };
    }
    switch (control.kind) {
      case "status": {
        // status never touches the driver and never extends the idle timer.
        return { schemaVersion: 1, info: info() };
      }
      case "diagnostics": {
        // Internal-only: driver init count + delivered mutations. Never
        // part of the public control contract beyond status fields.
        return { schemaVersion: 1, info: info(), diagnostics: hostDiagnostics() } as SessionControlReply & { diagnostics: Record<string, unknown> };
      }
      case "cancel": {
        const requestId = (control as { requestId?: string }).requestId;
        if (inFlight === null || inFlight.requestId !== requestId) {
          return { schemaVersion: 1, info: info() };
        }
        // Admission for this request is closed synchronously via the abort
        // signal. The hosted batch is dispatched one action at a time, so the
        // driver can finish the current native call but must refuse every
        // undispatched action. If a native call never settles, the bounded
        // watchdog below tears down the driver and reports unknown.
        inFlight.abort.abort();
        void (async () => {
          await new Promise((resolve) => setTimeout(resolve, SHUTDOWN_INFLIGHT_BUDGET_MS));
          if (inFlight?.requestId === requestId) void shutdown(`cancel-timeout:${requestId}`, true);
        })();
        return { schemaVersion: 1, info: info() };
      }
      case "close": {
        closeRequested = true;
        // A repeated close joins the original shutdown rather than returning
        // a transient `stopping` state. The bounded race keeps status/control
        // responsive if a native worker cannot be reclaimed.
        const pendingShutdown = shutdownPromise ?? shutdown("close");
        const final = finalized
          ? info()
          : await Promise.race([
              pendingShutdown,
              new Promise<SessionInfo>((resolve) => setTimeout(() => resolve(info()), CLOSE_CONTROL_BUDGET_MS).unref())
            ]);
        const cleanup: CleanupReport = {
          driverTerminated: final.state === "closed",
          leaseReleased,
          unresolvedRequests: requests.unresolvedIds
        };
        return { schemaVersion: 1, info: final, cleanup } as SessionControlReply & { cleanup: CleanupReport };
      }
      default:
        return { schemaVersion: 1, error: { code: "protocol_control", message: "unknown control kind" } };
    }
  };

  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(config.socketPath, () => resolve());
  });
  state.value = "idle";
  writeMetadata();
  scheduleIdle();

  return {
    info,
    socketPath: () => config.socketPath,
    close: async () => {
      closeRequested = true;
      const final = await shutdown("close");
      if (final.state === "unusable") closeSocket();
      return final;
    },
    waitUntilClosed: () =>
      new Promise((resolve) => (finalized ? resolve(info()) : closeWaiters.push(resolve))),
    waitUntilListenerClosed: () =>
      new Promise((resolve) => (listenerClosed ? resolve() : listenerCloseWaiters.push(resolve)))
  };
}

let cachedProcessStart: string | undefined;
function processStartTimeCached(): string | undefined {
  cachedProcessStart ??= processStartTime(process.pid);
  return cachedProcessStart;
}

/** Host entrypoint (`yk __computer-session-host <config>`). */
export async function hostMain(configPath: string): Promise<number> {
  const config = JSON.parse(await readFile(configPath, "utf8")) as HostConfig;
  const host = await startHost(config);
  const info = await host.waitUntilClosed();
  // Unknown is a request/driver terminal state, not a control-plane exit.
  // Keep the host alive for status and deduplicated replies until explicit close.
  await host.waitUntilListenerClosed();
  // `cli.ts` uses process.exit for internal entrypoints. Give any control
  // handler that triggered the final shutdown one event-loop turn to write
  // its terminal reply before the host process exits.
  await new Promise<void>((resolve) => setImmediate(resolve));
  return info.state === "unusable" ? 3 : 0;
}
