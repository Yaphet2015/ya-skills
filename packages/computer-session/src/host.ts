// Session host (B2/B3): the single local owner of one desktop target. It
// listens on the private session socket, keeps the driver worker in a
// dedicated process, dedupes requests through the runtime RequestJournal,
// holds the application-level target lease, and stays responsive for
// status/cancel/close while a business operation is running.
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
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  acquireTargetLease,
  canonicalRequestHash,
  ComputerError,
  createRequestJournal,
  validateBatch,
  DEFAULT_BATCH_TIMEOUT_MS,
  processStartTime,
  type LeaseHandle,
  type RequestJournal
} from "@ya-skills/computer-runtime";
import {
  decodeReply,
  decodeRequest,
  encodeControl,
  encodeRequest,
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
import {
  spawnInternalWorker,
  stopProcessGroup,
  TERM_GRACE_MS,
  type StopResult
} from "./process.js";
import { buildDriverSession, type DriverMethod, type DriverSessionLike } from "./driver-worker.js";
import {
  execStateHash,
  loadExecState,
  loadExecStateVersion
} from "./exec-state.js";

export const MAX_IDLE_TIMEOUT_MS = 120_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
/** Bounded wait for an in-flight business call during shutdown. */
const SHUTDOWN_INFLIGHT_BUDGET_MS = 10_000;
/** Bounded wait for a `close` control to observe the final state. */
const CLOSE_CONTROL_BUDGET_MS = 10_000;

export interface HostConfig {
  schemaVersion: 1;
  sessionId: string;
  generation: string;
  target: { pid: number; windowId: string };
  root: string;
  socketPath: string;
  idleTimeoutMs: number;
  /** Per-session request journal directory (session-private since B3/F7). */
  requestsDir: string;
  /** Internal test injection only (absolute module path). */
  driver?: { kind: "module"; path: string; export?: string };
  /** In-process driver session (tests); overrides `driver`. */
  inProcessDriver?: DriverSessionLike;
}

export interface DriverHandle {
  ready: Promise<void>;
  initCount: number;
  pid(): number | null;
  call(method: DriverMethod, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  alive(): boolean;
  stop(graceMs?: number): Promise<StopResult>;
}

// ---- subprocess driver handle (production) -------------------------------

async function subprocessDriver(
  config: HostConfig,
  onAction: (event: { phase: "started" | "finished"; kind: string; outcome?: string }) => void
): Promise<DriverHandle> {
  const { writeFile, mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const configDir = await mkdtemp(join(tmpdir(), "yk-cu-drv-"));
  const workerConfig = join(configDir, "driver.json");
  await writeFile(
    workerConfig,
    JSON.stringify({
      sessionId: config.sessionId,
      target: config.target,
      ...(config.driver ? { driver: config.driver } : {})
    })
  );
  const { child } = spawnInternalWorker("__computer-driver-worker", workerConfig, {
    env: { YK_CU_SESSION_ROOT: config.root }
  });
  const stdoutReader = new FrameReader();
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  let initCount = 0;
  let exited = false;
  let readyResolve!: () => void;
  const ready = new Promise<void>((resolve) => (readyResolve = resolve));
  child.stdout!.on("data", (chunk: Buffer) => {
    // Streaming UTF-8 (F17): a multibyte sequence split across chunk
    // boundaries survives intact.
    let frames: string[];
    try {
      frames = stdoutReader.push(chunk);
    } catch {
      child.kill("SIGKILL");
      return;
    }
    for (const line of frames) {
      if (line.trim() === "") continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (message.event === "ready") {
        initCount = Number(message.driverInitCount ?? 1);
        readyResolve();
        continue;
      }
      if (message.event === "action") {
        onAction({
          phase: message.phase === "finished" ? "finished" : "started",
          kind: typeof message.kind === "string" ? message.kind : "unknown",
          outcome: typeof message.outcome === "string" ? message.outcome : undefined
        });
        continue;
      }
      const id = typeof message.id === "string" ? message.id : null;
      if (id && pending.has(id)) {
        const waiter = pending.get(id)!;
        pending.delete(id);
        if (message.ok === true) waiter.resolve(message.result);
        else {
          const error = message.error as { code?: string; message?: string } | undefined;
          waiter.reject(new ComputerError(error?.code ?? "driver_error", error?.message ?? "driver call failed"));
        }
      }
    }
  });
  child.on("exit", () => {
    exited = true;
    void rm(configDir, { recursive: true, force: true }).catch(() => undefined);
    readyResolve();
    const error = new ComputerError("driver_worker_exited", "the driver worker exited unexpectedly", "unknown");
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });
  await ready;
  if (exited || child.pid === undefined) {
    throw new ComputerError("driver_worker_failed", "the driver worker exited before becoming ready");
  }
  return {
    ready,
    get initCount() {
      return initCount;
    },
    pid: () => child.pid ?? null,
    call(method, args, signal) {
      return new Promise((resolve, reject) => {
        if (exited) {
          reject(new ComputerError("driver_worker_exited", "the driver worker is gone", "unknown"));
          return;
        }
        if (signal?.aborted) {
          reject(new ComputerError("aborted", "the driver call was aborted", "not_delivered"));
          return;
        }
        const id = randomUUID();
        const onAbort = () => {
          try {
            child.stdin?.write(`${JSON.stringify({ control: "cancel", requestId: id })}\n`);
          } catch {
            // The worker exit path below classifies delivery as unknown.
          }
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        pending.set(id, {
          resolve: (value) => {
            signal?.removeEventListener("abort", onAbort);
            resolve(value);
          },
          reject: (error) => {
            signal?.removeEventListener("abort", onAbort);
            reject(error);
          }
        });
        try {
          child.stdin!.write(
            `${JSON.stringify({ id, method, args }, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}\n`
          );
        } catch (error) {
          pending.delete(id);
          signal?.removeEventListener("abort", onAbort);
          reject(new ComputerError("driver_worker_exited", `could not send driver request: ${error instanceof Error ? error.message : String(error)}`, "unknown"));
        }
      });
    },
    alive: () => !exited,
    stop(graceMs = TERM_GRACE_MS) {
      return stopProcessGroup(child, graceMs);
    }
  };
}

// ---- in-process driver handle (tests) ------------------------------------

async function inProcessDriver(
  config: HostConfig,
  onAction: (event: { phase: "started" | "finished"; kind: string; outcome?: string }) => void
): Promise<DriverHandle> {
  const session =
    config.inProcessDriver ??
    (await buildDriverSession({
      sessionId: config.sessionId,
      target: config.target,
      onAction,
      ...(config.driver ? { driver: config.driver } : {})
    }));
  let closed = false;
  return {
    ready: Promise.resolve(),
    initCount: session.initCount ?? 1,
    pid: () => null,
    async call(method, args, signal) {
      if (closed) throw new ComputerError("driver_worker_exited", "the driver worker is closed", "unknown");
      return session.call(method, args, signal);
    },
    alive: () => !closed,
    async stop() {
      closed = true;
      let cleanupFailed = false;
      try {
        await session.close();
      } catch {
        cleanupFailed = true;
      }
      return {
        exited: !cleanupFailed,
        signal: null,
        code: cleanupFailed ? null : 0,
        groupSurvivors: cleanupFailed ? 0 : null
      };
    }
  };
}

// ---- host -----------------------------------------------------------------

export interface Host {
  info(): SessionInfo;
  socketPath(): string;
  close(): Promise<SessionInfo>;
  waitUntilClosed(): Promise<SessionInfo>;
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

type StateCommitDisposition = "committed" | "abandoned" | "uncertain";

function classifyExecStateCommit(result: unknown): StateCommitDisposition {
  if (typeof result !== "object" || result === null) return "uncertain";
  const value = result as {
    status?: unknown;
    stateCommitted?: unknown;
    error?: { code?: unknown };
  };
  if (value.stateCommitted === true) return "committed";
  // The runner checks the request signal after the durable intent and before
  // the synchronous state rename. A terminal cancellation with no commit is
  // therefore conclusive; all other false values remain crash-uncertain.
  if (value.status === "interrupted" && value.error?.code === "request_cancelled") {
    return "abandoned";
  }
  return "uncertain";
}

function isMissingStateHistory(error: unknown): boolean {
  return error instanceof Error && /missing committed state history version/.test(error.message);
}

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
  let inFlight: { requestId: string; abort: AbortController } | null = null;
  let deliveries = 0;
  const requestOutcomes = new Map<string, { status: SessionReply["status"]; result?: unknown; error?: { code: string; message: string } }>();
  const unresolvedRequests = new Set<string>();
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
  const journalSeq = new Map<string, number>();
  const appendJournalEvent = async (
    requestId: string,
    type: "request_started" | "action_started" | "action_finished" | "state_commit_intent" | "request_finished",
    payload: Record<string, unknown>
  ): Promise<void> => {
    // Do not advance the sequence until the append succeeds. This prevents a
    // failed persistence attempt from making a subsequent recovery read look
    // valid while silently skipping an event.
    const seq = journalSeq.get(requestId) ?? 0;
    await journal.append(requestId, { seq, time: Date.now(), type, payload });
    journalSeq.set(requestId, seq + 1);
  };

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
    driver = driverMode === "in-process" ? await inProcessDriver(config, () => undefined) : await subprocessDriver(config, () => undefined);
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
        const outcome = requestOutcomes.get(inFlight.requestId) ?? {
          status: "unknown" as const,
          error: { code: "session_closing", message: `session closed (${reason}) with the request in flight` }
        };
        if (outcome.status !== "completed") {
          unresolvedRequests.add(inFlight.requestId);
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
      // A closed host removes its listener/path. An unusable host remains a
      // live, queryable listener until the owning process explicitly exits;
      // this lets callers retrieve the recorded unknown result. `hostMain`
      // and the public close path perform the final listener removal, so no
      // dead socket path survives process exit.
      if (state.value === "closed") {
        try {
          rmSync(config.socketPath, { force: true });
        } catch {
          // best effort
        }
        if (server !== null) {
          server.close();
          server = null;
        }
      }
      writeMetadata();
      finalized = true;
      const final = info();
      for (const waiter of closeWaiters.splice(0)) waiter(final);
      return final;
    })();
    return shutdownPromise;
  };

  /** Execute a hosted batch one action at a time. The runtime still owns
   * selector/condition semantics, but the host owns the durable boundary:
   * action_finished is acknowledged before the next native input is sent.
   * This also gives cancellation a boundary between actions instead of
   * handing an opaque multi-step call to the driver worker. */
  const executeHostedBatch = async (
    requestId: string,
    request: ReturnType<typeof validateBatch>,
    signal: AbortSignal,
    absoluteDeadlineAt: number,
    finishedActions?: Set<number>
  ): Promise<{ status: "completed" | "interrupted" | "failed"; steps: Array<Record<string, unknown>>; observation?: unknown; observationError?: { code: string; message: string } }> => {
    const steps: Array<Record<string, unknown>> = [];
    const fillNotRun = async (from: number, error: { code: string; message: string }): Promise<void> => {
      for (let index = from; index < request.actions.length; index++) {
        steps[index] = {
          index,
          kind: request.actions[index]!.kind,
          status: "not_run",
          error
        };
        await appendJournalEvent(requestId, "action_finished", {
          index,
          kind: request.actions[index]!.kind,
          outcome: "not_run",
          error
        });
        finishedActions?.add(index);
      }
    };
    const deadlineAt = Math.min(absoluteDeadlineAt, Date.now() + (request.timeoutMs ?? DEFAULT_BATCH_TIMEOUT_MS));
    for (const [index, action] of request.actions.entries()) {
      const boundary = signal.aborted
        ? { code: "request_cancelled", message: "the batch was cancelled before this action was dispatched" }
        : Date.now() >= deadlineAt
          ? { code: "batch_deadline", message: "batch timeout budget exhausted before dispatch" }
          : null;
      if (boundary !== null) {
        await fillNotRun(index, boundary);
        return { status: "interrupted", steps };
      }
      await appendJournalEvent(requestId, "action_started", { index, kind: action.kind });
      const afterJournal = signal.aborted
        ? { code: "request_cancelled", message: "the batch was cancelled before this action was dispatched" }
        : Date.now() >= deadlineAt
          ? { code: "batch_deadline", message: "batch timeout budget exhausted before dispatch" }
          : null;
      if (afterJournal !== null) {
        await fillNotRun(index, afterJournal);
        return { status: "interrupted", steps };
      }
      // Recompute the remaining budget after every journal await. Never pass
      // a stale relative timeout to a fresh driver call.
      const remaining = deadlineAt - Date.now();
      let raw: unknown;
      try {
        raw = await driver.call(
          "batch",
          {
            request: {
              actions: [action],
              timeoutMs: Math.max(1, Math.min(remaining, 120_000)),
              maxActions: 1
            }
          },
          signal
        );
      } catch (error) {
        const failure = {
          code: error instanceof ComputerError ? error.code : "driver_worker_exited",
          message: error instanceof Error ? error.message : String(error)
        };
        const receipt = { index, kind: action.kind, status: "unknown", error: failure };
        steps[index] = receipt;
        await appendJournalEvent(requestId, "action_finished", { index, kind: action.kind, outcome: "unknown", error: failure });
        finishedActions?.add(index);
        await fillNotRun(index + 1, { code: "not_run_after_unknown", message: "the preceding action had unknown delivery; remaining actions were not dispatched" });
        return { status: "interrupted", steps };
      }
      const result = raw as { status?: unknown; steps?: Array<Record<string, unknown>> } | null;
      const local = result?.steps?.[0];
      const localStatus = typeof local?.status === "string" ? local.status : "unknown";
      const receipt: Record<string, unknown> = {
        ...(local ?? {}),
        index,
        kind: action.kind,
        status: localStatus
      };
      steps[index] = receipt;
      await appendJournalEvent(requestId, "action_finished", {
        index,
        kind: action.kind,
        outcome: localStatus,
        ...(local?.error !== undefined ? { error: local.error } : {})
      });
      finishedActions?.add(index);
      if (localStatus !== "delivered" && localStatus !== "satisfied") {
        await fillNotRun(index + 1, {
          code: typeof (local?.error as { code?: unknown } | undefined)?.code === "string"
            ? (local?.error as { code: string }).code
            : localStatus === "unknown" ? "unknown_delivery" : "action_failed",
          message: typeof (local?.error as { message?: unknown } | undefined)?.message === "string"
            ? (local?.error as { message: string }).message
            : `the action ended with ${localStatus}`
        });
        return {
          status: localStatus === "unknown" || result?.status === "interrupted" ? "interrupted" : "failed",
          steps
        };
      }
      const afterAction = signal.aborted
        ? { code: "request_cancelled", message: "the batch was cancelled after this action" }
        : Date.now() >= deadlineAt
          ? { code: "batch_deadline", message: "batch timeout budget exhausted after this action" }
          : null;
      if (afterAction !== null) {
        await fillNotRun(index + 1, afterAction);
        return { status: "interrupted", steps };
      }
    }
    if (request.observe !== undefined) {
      const beforeObservation = signal.aborted
        ? { code: "request_cancelled", message: "the batch was cancelled before final observation" }
        : Date.now() >= deadlineAt
          ? { code: "batch_deadline", message: "batch timeout budget exhausted before final observation" }
          : null;
      if (beforeObservation !== null) return { status: "interrupted", steps, observationError: beforeObservation };
      try {
        const observation = await driver.call(
          "observe",
          { options: request.observe, deadlineAt },
          signal
        );
        if (signal.aborted || Date.now() >= deadlineAt) {
          return {
            status: "interrupted",
            steps,
            observationError: signal.aborted
              ? { code: "request_cancelled", message: "the batch was cancelled during final observation" }
              : { code: "batch_deadline", message: "batch timeout budget exhausted during final observation" }
          };
        }
        return { status: "completed", steps, observation };
      } catch (error) {
        const cancelled = signal.aborted || error instanceof ComputerError && (error.code === "aborted" || error.code === "request_cancelled");
        const expired = Date.now() >= deadlineAt;
        return {
          status: cancelled || expired ? "interrupted" : "completed",
          steps,
          observationError: {
            code: cancelled ? "request_cancelled" : expired ? "batch_deadline" : error instanceof ComputerError ? error.code : "final_observe_failed",
            message: cancelled
              ? "the batch was cancelled during final observation"
              : expired
                ? "batch timeout budget exhausted during final observation"
                : error instanceof Error ? error.message : String(error)
          }
        };
      }
    }
    return { status: "completed", steps };
  };

  const recordOutcome = async (
    requestId: string,
    outcome: { status: SessionReply["status"]; result?: unknown; error?: { code: string; message: string } },
    stateCommitDisposition?: StateCommitDisposition
  ): Promise<boolean> => {
    // A terminal reply is not published until its terminal event is durable.
    // If persistence fails after input was dispatched, fail closed and keep
    // the target unusable rather than claiming a recoverable success.
    try {
      await appendJournalEvent(requestId, "request_finished", {
        status: outcome.status,
        ...(outcome.result !== undefined ? { result: outcome.result } : {}),
        ...(outcome.error !== undefined ? { error: outcome.error } : {}),
        ...(stateCommitDisposition !== undefined ? { stateCommitDisposition } : {})
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.value = "unusable";
      unresolvedRequests.add(requestId);
      requestOutcomes.set(requestId, {
        status: "unknown",
        error: { code: "journal_error", message: `could not persist terminal request outcome: ${message}` }
      });
      return false;
    }
    requestOutcomes.set(requestId, outcome);
    unresolvedRequests.delete(requestId);
    return true;
  };

  const validateRecoveredExecState = (
    record: Awaited<ReturnType<RequestJournal["read"]>>,
    expectedRequestId?: string
  ): boolean => {
    const value = record.result as {
      status?: unknown;
      stateCommitted?: unknown;
      stateVersion?: unknown;
      stateHash?: unknown;
      error?: { code?: unknown };
    } | undefined;
    const intent = record.events.find((event) => event.type === "state_commit_intent");
    if (intent === undefined) return value?.stateCommitted !== true;
    const payload = intent.payload;
    if (
      typeof payload.requestId !== "string" ||
      payload.requestId.length === 0 ||
      (expectedRequestId !== undefined && payload.requestId !== expectedRequestId) ||
      typeof payload.expectedVersion !== "number" ||
      !Number.isSafeInteger(payload.expectedVersion) ||
      typeof payload.version !== "number" ||
      !Number.isSafeInteger(payload.version) ||
      payload.version !== payload.expectedVersion + 1 ||
      typeof payload.stateHash !== "string"
    ) return false;
    const finished = [...record.events].reverse().find((event) => event.type === "request_finished");
    const disposition = finished?.payload.stateCommitDisposition;
    if (
      disposition !== undefined &&
      disposition !== "committed" &&
      disposition !== "abandoned" &&
      disposition !== "uncertain"
    ) return false;
    const terminalProvesAbandoned =
      finished?.payload.status === "interrupted" &&
      value?.status === "interrupted" &&
      value.stateCommitted === false &&
      value.error?.code === "request_cancelled";
    const explicitlyAbandoned =
      terminalProvesAbandoned && (disposition === undefined || disposition === "abandoned");
    // Only the runner's post-intent cancellation check can make a no-commit
    // result conclusive. A failed commit, timeout, unknown delivery, or a
    // hand-written/malformed terminal marker remains crash-uncertain.
    if (disposition === "abandoned" && !explicitlyAbandoned) return false;
    if (disposition === "committed" && value?.stateCommitted !== true) return false;
    try {
      const current = loadExecState(stateDir);
      if (explicitlyAbandoned) {
        // Prove that the proposed version did not land. The normal case is an
        // unchanged head with no history file. If a later request consumed
        // the version, its durable request id proves that this intent did not
        // commit even when both requests produced identical JSON content.
        if (current.version < payload.expectedVersion) return false;
        try {
          const snapshot = loadExecStateVersion(stateDir, payload.version);
          // A history entry while the head is still at expectedVersion is an
          // orphaned partial commit, not proof of this cancellation. Keep the
          // session blocked rather than letting the next commit collide with
          // unverifiable history.
          if (current.version === payload.expectedVersion) return false;
          return snapshot.requestId !== undefined && snapshot.requestId !== payload.requestId;
        } catch (error) {
          return current.version === payload.expectedVersion && isMissingStateHistory(error);
        }
      }
      // For committed and crash-uncertain intents, only a matching historical
      // snapshot with the same durable request owner proves that the atomic
      // rename landed. Content hashes detect corruption; they do not establish
      // which request performed an identical commit.
      if (current.version < payload.version) return false;
      const snapshot = loadExecStateVersion(stateDir, payload.version);
      if (snapshot.requestId !== payload.requestId) return false;
      if (snapshot.hash !== payload.stateHash) return false;
      if (value?.stateCommitted === true) {
        return finished !== undefined &&
          typeof value.stateVersion === "number" &&
          value.stateVersion === payload.version &&
          typeof value.stateHash === "string" &&
          value.stateHash === payload.stateHash;
      }
      // A crash after the atomic state rename but before request_finished is
      // recoverable as an UNKNOWN request once its commit intent is proven.
      return true;
    } catch {
      return false;
    }
  };

  const validateStateBeforeAdmission = async (): Promise<void> => {
    // Load the current head first so a corrupt state file blocks every new
    // mutation. Then validate every historical commit intent, including an
    // intent whose terminal event was lost in a host crash.
    loadExecState(stateDir);
    for (const requestId of await journal.list()) {
      const record = await journal.read(requestId);
      if (record.status === "running" && requestId !== activeRequestId) {
        throw new Error(`request ${requestId} is still running; recovery ownership is not proven`);
      }
      if (record.events.some((event) => event.type === "state_commit_intent") && !validateRecoveredExecState(record, requestId)) {
        throw new Error(`request ${requestId} has an unverifiable state commit history`);
      }
    }
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
    // 1. dedup FIRST (before busy): same id returns the recorded outcome.
    const hash = canonicalRequestHash({
      kind: request.operation.kind,
      target: config.target,
      operation: request.operation
    });
    let claim: "new" | "existing" | "conflict";
    try {
      claim = await journal.claim(request.requestId, hash);
    } catch (error) {
      return errorReply(request, "journal_error", error instanceof Error ? error.message : String(error));
    }
    if (claim === "conflict") {
      return errorReply(request, "request_conflict", `request ${request.requestId} was used with different content`);
    }
    if (claim === "existing") {
      const prior = requestOutcomes.get(request.requestId);
      if (prior) {
        return { schemaVersion: 1, requestId: request.requestId, status: prior.status, ...(prior.result !== undefined ? { result: prior.result } : {}), ...(prior.error ? { error: prior.error } : {}) };
      }
      let record;
      try {
        record = await journal.read(request.requestId);
      } catch {
        return errorReply(request, "journal_error", "request record is unreadable");
      }
      if (record.status === "running") {
        // The request is already claimed by this or a previous host. A
        // duplicate is a status query, never a second dispatch.
        return { schemaVersion: 1, requestId: request.requestId, status: "running" };
      }
      if (request.operation.kind === "exec" && record.events.some((event) => event.type === "state_commit_intent") && !validateRecoveredExecState(record, request.requestId)) {
        state.value = "unusable";
        return {
          schemaVersion: 1,
          requestId: request.requestId,
          status: "unknown",
          error: { code: "state_recovery_mismatch", message: "the recorded exec state commit history is not verifiable; refusing to replay" }
        };
      }
      if (record.result !== undefined) {
        // Durable recovery of any terminal result (F8): the events file is
        // the SSOT — a recorded outcome is returned, never rerun. A committed
        // exec state must also agree with its intent/version/hash linkage.
        if (request.operation.kind === "exec" && !validateRecoveredExecState(record, request.requestId)) {
          state.value = "unusable";
          return {
            schemaVersion: 1,
            requestId: request.requestId,
            status: "unknown",
            error: { code: "state_recovery_mismatch", message: "the recorded exec state commit does not match state.json; refusing to replay" }
          };
        }
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
    if (admissionError) {
      try {
        // Rejected requests still get a durable terminal record, but they do
        // not reserve the active slot and never reach the driver.
        await appendJournalEvent(request.requestId, "request_started", { kind: request.operation.kind });
        await recordOutcome(request.requestId, { status: "failed", error: admissionError });
      } catch (error) {
        state.value = "unusable";
        unresolvedRequests.add(request.requestId);
        requestOutcomes.set(request.requestId, {
          status: "unknown",
          error: { code: "journal_error", message: error instanceof Error ? error.message : String(error) }
        });
      }
      return errorReply(request, admissionError.code, admissionError.message);
    }
    // 3. Reserve synchronously BEFORE the first post-admission await. A
    // single socket data event may contain two business frames; once this
    // slot is assigned, the second frame observes session_busy even while the
    // first request's request_started append is awaiting durability.
    const requestAbort = new AbortController();
    activeRequestId = request.requestId;
    inFlight = { requestId: request.requestId, abort: requestAbort };
    unresolvedRequests.add(request.requestId);
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
      try {
        await appendJournalEvent(request.requestId, "request_started", { kind: request.operation.kind });
        await recordOutcome(request.requestId, { status: "failed", error: stateAdmissionError });
      } catch (error) {
        state.value = "unusable";
        requestOutcomes.set(request.requestId, {
          status: "unknown",
          error: { code: "journal_error", message: error instanceof Error ? error.message : String(error) }
        });
      }
      inFlight = null;
      activeRequestId = undefined;
      return errorReply(request, stateAdmissionError.code, stateAdmissionError.message);
    }
    try {
      // 4. persist the start BEFORE dispatch (F8): a persistence failure
      // fails the request closed — desktop input never outruns its journal.
      await appendJournalEvent(request.requestId, "request_started", { kind: request.operation.kind });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.value = "unusable";
      requestOutcomes.set(request.requestId, { status: "unknown", error: { code: "journal_error", message } });
      inFlight = null;
      activeRequestId = undefined;
      return errorReply(request, "journal_error", `could not persist the request start — nothing was dispatched: ${message}`);
    }
    // 5. execute through the driver, exactly once. The request-local timer is
    // the deadline propagation path for a persistent driver: its observe
    // method receives this signal instead of silently resetting to a fresh
    // per-call budget.
    const requestDeadlineTimer = request.operation.kind === "observe" && Number.isFinite(requestDeadlineAt)
      ? setTimeout(() => requestAbort.abort(new Error("request deadline exceeded")), Math.max(1, requestDeadlineAt - Date.now()))
      : undefined;
    requestDeadlineTimer?.unref?.();
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
        const batch = await executeHostedBatch(request.requestId, validatedBatchRequest, requestAbort.signal, requestDeadlineAt, finishedBatchActions);
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
        if (status === "unknown") await terminateBeforeUnknownReply();
        const unknownStep = batchSteps.find((step) => step.status === "unknown") as { error?: { code?: string; message?: string } } | undefined;
        const batchError = status === "unknown"
          ? {
              code: typeof unknownStep?.error?.code === "string" ? unknownStep.error.code : "unknown_delivery",
              message: typeof unknownStep?.error?.message === "string" ? unknownStep.error.message : "batch delivery could not be confirmed"
            }
          : undefined;
        const durable = await recordOutcome(request.requestId, {
          status,
          result: batchResult,
          ...(batchError !== undefined ? { error: batchError } : {})
        });
        if (!durable) {
          state.value = "unusable";
          afterReply = () => void shutdown("journal-failure", false);
          return {
            schemaVersion: 1,
            requestId: request.requestId,
            status: "unknown",
            error: { code: "journal_error", message: "terminal batch outcome could not be persisted; delivery is unknown" }
          };
        }
        if (status === "unknown") {
          state.value = "unusable";
          afterReply = () => void shutdown("unknown-delivery", false);
        }
        return {
          schemaVersion: 1,
          requestId: request.requestId,
          status,
          result: batchResult,
          ...(batchError !== undefined ? { error: batchError } : {})
        };
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
            deadlineAt: requestDeadlineAt
          },
          request.requestId,
          options,
          inFlight.abort.signal
        );
        deliveries += result.actions.filter((a) => a.status === "delivered" || a.status === "satisfied").length;
        const status: SessionReply["status"] =
          result.status === "completed" ? "completed" : result.status === "interrupted" ? "interrupted" : result.status === "unknown" ? "unknown" : "failed";
        if (status === "unknown") await terminateBeforeUnknownReply();
        const durable = await recordOutcome(
          request.requestId,
          { status, result },
          classifyExecStateCommit(result)
        );
        if (!durable) {
          state.value = "unusable";
          afterReply = () => void shutdown("journal-failure", false);
          return {
            schemaVersion: 1,
            requestId: request.requestId,
            status: "unknown",
            error: { code: "journal_error", message: "terminal exec outcome could not be persisted; delivery is unknown" }
          };
        }
        if (status === "unknown") {
          state.value = "unusable";
          afterReply = () => void shutdown("unknown-delivery", false);
        }
        return { schemaVersion: 1, requestId: request.requestId, status, result };
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
      const status: SessionReply["status"] = "completed";
      const durable = await recordOutcome(request.requestId, { status, result: result ?? null });
      if (!durable) {
        state.value = "unusable";
        afterReply = () => void shutdown("journal-failure", false);
        return {
          schemaVersion: 1,
          requestId: request.requestId,
          status: "unknown",
          error: { code: "journal_error", message: "terminal request outcome could not be persisted; delivery is unknown" }
        };
      }
      return { schemaVersion: 1, requestId: request.requestId, status, result: result ?? null };
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
      if (status === "unknown") await terminateBeforeUnknownReply();
      const durable = await recordOutcome(request.requestId, { status, error: { code, message } });
      if (!durable) {
        state.value = "unusable";
        afterReply = () => void shutdown("journal-failure", false);
        return {
          schemaVersion: 1,
          requestId: request.requestId,
          status: "unknown",
          error: { code: "journal_error", message: "terminal request outcome could not be persisted; delivery is unknown" }
        };
      }
      if (!observationInterrupted && isUnknownDelivery(code)) {
        // Unknown native delivery: the driver is no longer trusted. Teardown
        // waits until THIS reply reaches the client (socket teardown must
        // never eat the terminal reply).
        state.value = "unusable";
        afterReply = () => void shutdown("unknown-delivery", false);
      }
      return { schemaVersion: 1, requestId: request.requestId, status, error: { code, message } };
    } finally {
      if (requestDeadlineTimer !== undefined) clearTimeout(requestDeadlineTimer);
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
        if (reply.info?.state === "closed" || reply.info?.state === "unusable") socket.end();
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
          unresolvedRequests: [...unresolvedRequests]
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

  const closeSocket = (): void => {
    if (server !== null) {
      server.close();
      server = null;
    }
    try {
      rmSync(config.socketPath, { force: true });
    } catch {
      // best effort
    }
  };
  return {
    info,
    socketPath: () => config.socketPath,
    close: async () => {
      const final = await shutdown("close");
      if (final.state === "unusable") closeSocket();
      return final;
    },
    waitUntilClosed: () =>
      new Promise((resolve) => (finalized ? resolve(info()) : closeWaiters.push(resolve)))
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
  // Close the final listener/path after the process-level owner has observed
  // the terminal state. During the short live-host window an unusable session
  // remains queryable; after this point no dead socket is left behind.
  await host.close();
  // `cli.ts` uses process.exit for internal entrypoints. Give any control
  // handler that triggered the final shutdown one event-loop turn to write
  // its terminal reply before the host process exits.
  await new Promise<void>((resolve) => setImmediate(resolve));
  return info.state === "unusable" ? 3 : 0;
}
