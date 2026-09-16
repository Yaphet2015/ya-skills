// Lazy driver session: one absolute deadline per native operation shared by
// load/create/work, signal + poison guards, idempotent ordered close. The
// session facade turns backend ToolResults and timeouts into ComputerError.

import type {
  AppRef,
  AxElement,
  Backend,
  BackendFactory,
  BatchRequest,
  BatchResult,
  Computer,
  NativeObservationLike,
  ObserveCallOptions,
  ObserveOptions,
  Observation,
  PointClick,
  Predicate,
  ScrollSpec,
  Snapshot,
  Target,
  ToolResultLike,
  WindowRef
} from "./types.js";
import { clickUnique, waitForElements } from "./actions.js";
import { normalizeElements, projectObservation } from "./observe.js";
import { artifactPath, ensureOutDir, ensurePrivateFile, saveScreenshot } from "./artifacts.js";
import { copyFileSync, statSync } from "node:fs";
import { mapImagePointToDriverPixels } from "./coordinates.js";
import {
  frameMatchesObservation,
  pngSha256,
  ProcessCleanupError,
  resizeScreenshot,
  type ObservationStore,
  type ResizeResult
} from "./observation-store.js";
import { validateBatch, runBatch, DEFAULT_BATCH_TIMEOUT_MS } from "./batch.js";
import { acquireTargetLease, LeaseError, type LeaseHandle, type LeaseOwner } from "./target-lease.js";
import { randomUUID } from "node:crypto";

export type { AxElement, Backend, BackendFactory, ToolResultLike } from "./types.js";

export const OP_LIMIT_MS = 30_000;
export const CLEANUP_BUDGET_MS = 5_000;

export class ComputerError extends Error {
  constructor(
    public code: string,
    message: string,
    public actionOutcome?: "delivered" | "not_delivered" | "unknown"
  ) {
    super(message);
  }
}

/** Mutation leases (B3): every mutation entry path (single-step CLI, batch
 * CLI, E2E) acquires the shared app-level target lease at the FIRST mutation
 * and releases it when the enclosing computer session closes. Session hosts
 * instead hold one lease for their configured target from open to close and
 * pass external ownership — the hosted driver session sets NO leases so it
 * never double-acquires its own host's lease. */
export interface MutationLeases {
  acquire(target: Target): Promise<LeaseHandle>;
}

/** Default auto-leases for non-session entry paths: one generation per
 * computer session, leases keyed by app pid, released together on close. */
export function createAutoLeases(
  root: string,
  kind: LeaseOwner["kind"]
): MutationLeases & { releaseAll(): Promise<void> } {
  const generation = randomUUID();
  const handles = new Map<number, LeaseHandle>();
  return {
    async acquire(target) {
      const existing = handles.get(target.pid);
      if (existing) return existing;
      const acquired = await acquireTargetLease(root, target, {
        generation,
        pid: process.pid,
        // The process-start probe is synchronous and can delay a desktop
        // worker cold start under Bun 1.3. PID reuse remains conservative
        // (a live PID blocks reclamation); persistent hosts include the
        // stronger start identity because they already have boot time.
        kind
      });
      // SessionImpl releases its handle during close. Remove the cached
      // handle then, otherwise a later one-shot session in this same process
      // would reuse a lease file that has already been deleted.
      const handle: LeaseHandle = {
        owner: acquired.owner,
        refreshOwner: acquired.refreshOwner,
        async release() {
          try {
            await acquired.release();
          } finally {
            if (handles.get(target.pid) === handle) handles.delete(target.pid);
          }
        }
      };
      handles.set(target.pid, handle);
      return handle;
    },
    async releaseAll() {
      const pending = [...handles.values()];
      handles.clear();
      const errors: unknown[] = [];
      for (const handle of pending) {
        try {
          await handle.release();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) throw errors[0];
    }
  };
}

export interface SessionOptions {
  onRuntime?: (info: { driverVersion: string; pid: number }) => void;
  signal?: AbortSignal;
  deadlineAt?: number;
  artifactsDir?: string;
  observationStore?: ObservationStore;
  /** Internal test seam for delaying or instrumenting same-frame derivation. */
  screenshotResizer?: (
    originalPath: string,
    maxDimension: number,
    options: { signal?: AbortSignal; deadlineAt: number }
  ) => Promise<ResizeResult>;
  /** Shared target-lease enforcement for mutation entry paths. */
  leases?: MutationLeases;
  onAction?: (event: {
    phase: "started" | "finished";
    kind: "click" | "click_point" | "type" | "key" | "scroll";
    outcome?: "delivered" | "not_delivered" | "unknown";
  }) => unknown;
}

/** Observations older than this are never clickable (A3 store test). */
export const OBSERVATION_TTL_MS = 60_000;

export interface ComputerSession {
  computer: Computer;
  metadata(): Promise<{ driverVersion: string; pid: number }>;
  permissions(): Promise<{ accessibility: boolean; screenRecording: boolean }>;
  close(): Promise<void>;
}

interface InternalOptions extends SessionOptions {
  cleanupDeadlineMs?: number;
}

const PREDISPATCH_TOOL_ERROR_CODES = new Set([
  "stale_element_token",
  "window_target_not_found",
  "px_capture_unavailable"
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function driverErrorTag(error: unknown): string | undefined {
  const root = asRecord(error);
  if (root === undefined) return undefined;
  if (typeof root.tag === "string") return root.tag;
  const nested = asRecord(root.tag);
  return typeof nested?.tag === "string" ? nested.tag : undefined;
}

function driverErrorCode(error: unknown): string | undefined {
  const root = asRecord(error);
  if (root === undefined) return undefined;
  const inner = asRecord(root.inner);
  if (typeof inner?.errorCode === "string") return inner.errorCode;
  return typeof root.errorCode === "string" ? root.errorCode : undefined;
}

function isKnownDriverRefusal(error: unknown): boolean {
  const root = asRecord(error);
  if (root === undefined) return false;
  const name = typeof root.name === "string" ? root.name : "";
  const tag = driverErrorTag(error);
  // InvalidArguments is rejected while constructing the request, before the
  // native input boundary. A Tool class name alone is not enough: the SDK can
  // use DriverError.Tool after an action has already entered the app.
  if (tag === "InvalidArguments" || name === "DriverError.InvalidArguments") return true;
  return PREDISPATCH_TOOL_ERROR_CODES.has(driverErrorCode(error) ?? "");
}

function isAbortError(error: unknown): boolean {
  return asRecord(error)?.name === "AbortError";
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && /timed out/.test(error.message);
}

function driverErrorDiagnostic(error: unknown): string {
  const base = error instanceof Error ? error.message : String(error);
  const root = asRecord(error);
  const tag = driverErrorTag(error);
  const name = typeof root?.name === "string" ? root.name : "";
  if (tag !== "Tool" && name !== "DriverError.Tool") return base;
  const code = driverErrorCode(error);
  // SDK messages can contain application content. The code is enough to
  // diagnose delivery classification without copying the whole inner error.
  return code !== undefined && /^[a-z0-9_]+$/i.test(code)
    ? `${base} (errorCode=${code})`
    : base;
}

function normalizeObserveCallOptions(callOptions?: ObserveCallOptions | AbortSignal): ObserveCallOptions {
  if (callOptions !== undefined && typeof callOptions === "object" && callOptions !== null &&
    "aborted" in callOptions && typeof (callOptions as AbortSignal).addEventListener === "function") {
    return { signal: callOptions as AbortSignal };
  }
  return (callOptions ?? {}) as ObserveCallOptions;
}

interface CombinedAbortSignal {
  signal?: AbortSignal;
  dispose(): void;
}

/** Combine session, batch, and per-call cancellation without mutating any
 * caller-owned signal. A direct observe signal must not mask a later session
 * shutdown, because post-read work can still publish an observation. */
function combineAbortSignals(signals: Array<AbortSignal | undefined>): CombinedAbortSignal {
  const unique = [...new Set(signals.filter((signal): signal is AbortSignal => signal !== undefined))];
  if (unique.length === 0) return { dispose() {} };
  if (unique.length === 1) return { signal: unique[0], dispose() {} };

  const controller = new AbortController();
  const listeners = unique.map((signal) => {
    const onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    return { signal, onAbort };
  });
  return {
    signal: controller.signal,
    dispose() {
      for (const { signal, onAbort } of listeners) signal.removeEventListener("abort", onAbort);
    }
  };
}

function withDeadline<T>(label: string, promise: Promise<T>, deadlineMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new ComputerError("aborted", `${label} was aborted`));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    if (Number.isFinite(deadlineMs)) {
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`${label} timed out after ${deadlineMs}ms`));
      }, Math.max(1, deadlineMs));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
  });
}

class SessionImpl implements ComputerSession {
  readonly computer: Computer;
  private backend: Backend | null = null;
  private initPromise: Promise<void> | null = null;
  private closed = false;
  private poisoned = false;
  private closePromise: Promise<void> | null = null;
  private runtimeInfo: { driverVersion: string; pid: number } | null = null;
  private runtimeNotified = false;
  /** Driver lifecycle identity: every session is a new epoch. */
  private readonly epoch = randomUUID();
  /** Bumped on every local mutation start (A4 staleness signal). */
  private revision = 0;
  /** App leases held by this computer session (first mutation per pid). */
  private readonly leaseHandles = new Map<number, LeaseHandle>();
  /** Every backend operation remains tracked after a Promise.race timeout.
   * A timed-out wrapper is not proof that native work stopped; close waits for
   * this set (or keeps the target lease when it cannot drain). */
  private readonly nativeInFlight = new Set<Promise<unknown>>();
  /** A derived screenshot process can fail after the caller-visible deadline.
   * Keep that failure durable so close cannot report safe cleanup later. */
  private nativeCleanupError: ProcessCleanupError | null = null;
  /** Absolute deadline of the batch currently executing (A5 budget
   * propagation): every native read/action/wait during a batch is capped by
   * it, not just the steps around it. */
  private batchDeadlineAt: number | null = null;
  /** Per-request cancellation for a hosted batch. This is separate from the
   * session-wide signal so one cancelled request does not poison a reused
   * driver session. */
  private batchSignal: AbortSignal | null = null;
  /** Operations reserve admission before any asynchronous lease/setup work.
   * close() waits for these reservations to drain so a late lease or driver
   * creation cannot cross the native seam after cleanup has started. */
  private pendingAdmissions = 0;

  constructor(
    private readonly factory: BackendFactory,
    private readonly options: InternalOptions
  ) {
    this.computer = {
      apps: () => this.read("list apps", (b) => b.apps()),
      windows: (pid: number, opts?: { onScreenOnly?: boolean }) =>
        this.read("list windows", (b) => b.windows(pid, opts?.onScreenOnly ?? false)),
      snapshot: (target: Target, opts?: { screenshot?: boolean }) =>
        this.read("snapshot", (b) => b.snapshot(target, opts?.screenshot ?? false)),
      observe: (target: Target, opts?: ObserveOptions, signal?: AbortSignal) => this.observe(target, opts, signal),
      clickPoint: (target: Target, point) => this.clickPoint(target, point),
      batch: (target: Target, request, signal?: AbortSignal) => this.batch(target, request, signal),
      click: (target: Target, predicate: Predicate, description: string) =>
        this.clickViaToken(target, predicate, description),
      type: (target: Target, text: string) => this.action("type", target, (b) => b.type(target, text)),
      key: (target: Target, key: string, modifiers?: string[]) =>
        this.action("key", target, (b) => b.key(target, key, modifiers)),
      scroll: (target: Target, spec: ScrollSpec) => this.action("scroll", target, (b) => b.scroll(target, spec)),
      waitFor: (target: Target, predicate, description: string, opts?: { timeoutMs?: number; intervalMs?: number }) =>
        this.waitFor(target, predicate, description, opts)
    };
  }

  // ---- guards + per-op absolute deadline ---------------------------------

  private beginOp(uncapped = false): number {
    if (this.closed) throw new ComputerError("session_closed", "the session is closed");
    if (this.poisoned) {
      throw new ComputerError(
        "session_unusable",
        "a previous action timed out with unknown delivery; this session refuses further operations — perceive the current state in a fresh session instead of replaying"
      );
    }
    if (this.nativeInFlight.size > 0) {
      throw new ComputerError(
        "session_busy",
        "a previous native operation is still settling; wait for cleanup or use a fresh session"
      );
    }
    if (this.options.signal?.aborted || this.batchSignal?.aborted) {
      throw new ComputerError("aborted", "the operation was aborted");
    }
    this.pendingAdmissions += 1;
    const cap = uncapped ? Infinity : OP_LIMIT_MS;
    return Math.min(
      this.options.deadlineAt ?? Infinity,
      this.batchDeadlineAt ?? Infinity,
      Date.now() + cap
    );
  }

  /** Release the reservation made by beginOp(), including when setup failed
   * before a backend call. The close path polls this count before cleanup. */
  private endOp(): void {
    if (this.pendingAdmissions > 0) this.pendingAdmissions -= 1;
  }

  private async waitForAdmissionsIdle(deadlineAt: number): Promise<boolean> {
    while (this.pendingAdmissions > 0 && Date.now() < deadlineAt) {
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(10, Math.max(deadlineAt - Date.now(), 1))));
    }
    return this.pendingAdmissions === 0;
  }

  /** Final admission check immediately before invoking a backend method.
   * Awaiting a lease, journal callback, invalidation, or driver setup can
   * consume the entire caller budget; no native request may cross the seam
   * after cancellation or expiration. */
  private assertDispatchAllowed(deadlineAt: number, outcome?: "not_delivered", operationSignal?: AbortSignal): void {
    // close() may race an operation that is still waiting for a lease or
    // driver setup. These lifecycle guards must be checked at the final
    // native seam, not only when beginOp() first reserved admission.
    if (this.closed) {
      throw new ComputerError("session_closed", "the session is closed", outcome);
    }
    if (this.poisoned) {
      throw new ComputerError(
        "session_unusable",
        "the session is unusable and refuses further native work",
        outcome
      );
    }
    if (this.options.signal?.aborted || this.batchSignal?.aborted || operationSignal?.aborted) {
      throw new ComputerError("aborted", "the operation was aborted", outcome);
    }
    if (Date.now() >= deadlineAt) {
      throw new ComputerError("command_timeout", "operation budget exhausted before native dispatch", outcome);
    }
  }

  private wrapAborted(error: unknown): unknown {
    if (isAbortError(error)) {
      return new ComputerError("aborted", "the operation was aborted");
    }
    return error;
  }

  private trackNative<T>(promise: Promise<T>, onRejected?: (error: unknown) => void): Promise<T> {
    const tracked = Promise.resolve(promise);
    this.nativeInFlight.add(tracked);
    void tracked.then(
      () => this.nativeInFlight.delete(tracked),
      (error) => {
        this.nativeInFlight.delete(tracked);
        onRejected?.(error);
      }
    );
    return tracked;
  }

  private async waitForNativeIdle(deadlineAt: number): Promise<boolean> {
    while (this.nativeInFlight.size > 0 && Date.now() < deadlineAt) {
      await Promise.race([
        ...this.nativeInFlight,
        new Promise((resolve) => setTimeout(resolve, Math.max(deadlineAt - Date.now(), 1)))
      ]).catch(() => undefined);
    }
    return this.nativeInFlight.size === 0;
  }

  private async ensureReady(deadlineAt: number): Promise<Backend> {
    // Setup itself must not begin after close/cancellation/deadline. Callers
    // still perform the final check after this await because lifecycle state
    // can change while initialization is in flight.
    this.assertDispatchAllowed(deadlineAt);
    if (this.backend) return this.backend;
    this.initPromise ??= this.initialize(deadlineAt);
    await this.initPromise;
    if (!this.backend) {
      throw new ComputerError("internal", "initialization finished without a backend");
    }
    return this.backend;
  }

  private async initialize(deadlineAt: number): Promise<void> {
    const remaining = () => {
      const ms = deadlineAt - Date.now();
      if (ms <= 0) {
        throw new ComputerError("command_timeout", "operation budget exhausted before the driver was ready");
      }
      return ms;
    };
    let sdk: unknown;
    try {
      sdk = await withDeadline("sdk load", this.trackNative(this.factory.load()), remaining());
    } catch (error) {
      if (isTimeoutError(error)) this.poisoned = true;
      throw this.wrapAborted(error);
    }
    const createPromise = this.factory.create(sdk);
    let backend: Backend;
    try {
      backend = await withDeadline("driver create", this.trackNative(createPromise), remaining());
    } catch (error) {
      if (isTimeoutError(error)) {
        // Promise timeouts do not cancel native work: the creation may still
        // land. Clean up whatever eventually appears; never use it for work.
        this.poisoned = true;
        createPromise
          .then((late) => {
            if (late) void this.cleanupBackend(late);
          })
          .catch(() => undefined);
        throw new ComputerError("command_timeout", String((error as Error).message), "unknown");
      }
      throw this.wrapAborted(error);
    }
    this.backend = backend;
    // Metadata rides in the SAME operation budget, is cached, and its failure
    // is non-fatal — reporting must never re-open a driver for a version.
    try {
      const meta = await withDeadline("metadata", this.trackNative(backend.metadata()), remaining());
      if (meta?.driverVersion !== undefined && meta?.pid !== undefined) {
        this.runtimeInfo = { driverVersion: meta.driverVersion, pid: meta.pid };
        this.notifyRuntime();
      }
    } catch {
      // stays uncached; a later metadata() call may retry
    }
  }

  private notifyRuntime(): void {
    if (this.runtimeInfo && !this.runtimeNotified) {
      this.runtimeNotified = true;
      this.options.onRuntime?.(this.runtimeInfo);
    }
  }

  // ---- reads: timeout is reportable but does not poison ------------------

  private async read<T>(
    label: string,
    fn: (backend: Backend, context: { signal?: AbortSignal; deadlineAt: number }) => Promise<T>,
    callOptions?: ObserveCallOptions
  ): Promise<T> {
    const deadlineAt = Math.min(this.beginOp(), callOptions?.deadlineAt ?? Infinity);
    const operationSignal = callOptions?.signal ?? this.batchSignal ?? this.options.signal;
    try {
      if (operationSignal?.aborted) {
        throw new ComputerError("aborted", "the operation was aborted");
      }
      let backend: Backend;
      try {
        backend = await withDeadline(
          "driver setup",
          this.trackNative(this.ensureReady(deadlineAt)),
          // ensureReady owns the absolute setup deadline so its late-create
          // cleanup path can observe the real factory promise. This wrapper
          // adds only request-local cancellation; racing a second timeout
          // here could win before ensureReady records the late backend.
          Number.POSITIVE_INFINITY,
          operationSignal
        );
      } catch (error) {
        if (isTimeoutError(error)) {
          throw new ComputerError("command_timeout", (error as Error).message);
        }
        throw this.wrapAborted(error);
      }
      this.assertDispatchAllowed(deadlineAt, undefined, operationSignal);
      try {
        return await withDeadline(
          label,
          this.trackNative(fn(backend, { signal: operationSignal, deadlineAt })),
          Math.max(deadlineAt - Date.now(), 1),
          operationSignal
        );
      } catch (error) {
        if (isTimeoutError(error)) {
          throw new ComputerError("command_timeout", (error as Error).message);
        }
        throw this.wrapAborted(error);
      }
    } finally {
      this.endOp();
    }
  }

  // ---- observe: independent channels, metadata injection, image persist ---

  private observationControlError(
    deadlineAt: number,
    operationSignal: AbortSignal | undefined,
    phase: string
  ): ComputerError | undefined {
    // Check every signal source. A direct call can provide its own signal;
    // batch and session signals still must invalidate post-read publishing.
    if (
      operationSignal?.aborted ||
      this.batchSignal?.aborted ||
      this.options.signal?.aborted
    ) {
      return new ComputerError("aborted", `the observation was aborted ${phase}`);
    }
    if (this.closed) {
      return new ComputerError("session_closed", `the session closed ${phase}`);
    }
    if (Date.now() >= deadlineAt) {
      return new ComputerError("command_timeout", `the observation budget expired ${phase}`);
    }
    return undefined;
  }

  private assertObservationAllowed(
    deadlineAt: number,
    operationSignal: AbortSignal | undefined,
    phase: string
  ): void {
    const controlError = this.observationControlError(deadlineAt, operationSignal, phase);
    if (controlError) throw controlError;
  }

  private stampObservation(raw: unknown): NativeObservationLike {
    return {
      ...(raw as object),
      observationId: randomUUID(),
      capturedAt: Date.now(),
      epoch: this.epoch,
      revision: this.revision
    } as NativeObservationLike;
  }

  private persistImage(raw: NativeObservationLike): string | undefined {
    const base64 = raw.images?.[0]?.dataBase64;
    try {
      if (typeof base64 === "string" && base64.length > 0) {
        return saveScreenshot(ensureOutDir(this.options.artifactsDir), base64);
      }
      const source = raw.screenshotFilePath;
      if (typeof source === "string" && source.length > 0) {
        const stats = statSync(source);
        if (!stats.isFile() || stats.size <= 0) throw new Error(`screenshot file is empty or not a regular file: ${source}`);
        const destination = artifactPath(ensureOutDir(this.options.artifactsDir), "cu.png");
        copyFileSync(source, destination);
        // copyFileSync does not honor a mode argument and may inherit a
        // permissive source mode. Enforce the artifact contract on the actual
        // destination and let chmod/stat failures escape loudly.
        ensurePrivateFile(destination);
        return destination;
      }
      return undefined;
    } catch (error) {
      // Fail loud: the screenshot bytes exist but the evidence artifact does
      // not. A "usable" image channel without a persisted file would be a
      // fabricated success (A2/A3 fail-loud contract).
      throw new ComputerError(
        "artifact_write_failed",
        `the screenshot could not be persisted: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async readObservation(
    target: Target,
    channels: { accessibility: boolean; screenshot: boolean; maxDimension?: number },
    callOptions?: ObserveCallOptions
  ): Promise<NativeObservationLike> {
    return this.read("observe", (b, context) => b.observe(target, channels, context), callOptions);
  }

  private async observe(
    target: Target,
    opts?: ObserveOptions,
    rawCallOptions?: ObserveCallOptions | AbortSignal
  ): Promise<Observation> {
    const callOptions = normalizeObserveCallOptions(rawCallOptions);
    const mode = opts?.mode ?? "auto";
    if (mode !== "auto" && mode !== "ax" && mode !== "image" && mode !== "both") {
      throw new ComputerError("invalid_request", `unknown observation mode: ${String(mode)}`);
    }
    if (opts?.maxDimension !== undefined &&
      (!Number.isSafeInteger(opts.maxDimension) || opts.maxDimension < 64 || opts.maxDimension > 8192)) {
      throw new ComputerError("invalid_request", "maxDimension must be a safe integer between 64 and 8192");
    }
    if (opts?.selector !== undefined &&
      (typeof opts.selector.text !== "string" || opts.selector.text.length === 0 ||
        (opts.selector.match !== "exact" && opts.selector.match !== "contains") ||
        (opts.selector.role !== undefined && (typeof opts.selector.role !== "string" || opts.selector.role.length === 0)))) {
      throw new ComputerError("invalid_request", "observation selector is invalid");
    }

    // Reserve one operation admission for the complete observe lifecycle. The
    // nested native reads have their own reservations, but this outer one also
    // covers synchronous image persistence and asynchronous derivation/store
    // work so close() cannot clean the backend during final publication.
    const deadlineAt = Math.min(this.beginOp(), callOptions.deadlineAt ?? Infinity);
    const combinedSignal = combineAbortSignals([
      callOptions.signal,
      this.batchSignal ?? undefined,
      this.options.signal
    ]);
    const operationSignal = combinedSignal.signal;
    const nativeCallOptions: ObserveCallOptions = {
      ...(operationSignal !== undefined ? { signal: operationSignal } : {}),
      deadlineAt
    };
    try {
      this.assertObservationAllowed(deadlineAt, operationSignal, "before native read");

      let raw: NativeObservationLike;
      let requested: { accessibility: boolean; screenshot: boolean };
      if (mode === "ax") {
        requested = { accessibility: true, screenshot: false };
        raw = await this.readObservation(target, requested, nativeCallOptions);
      } else if (mode === "image" || mode === "both") {
        requested = { accessibility: mode === "both", screenshot: true };
        raw = await this.readObservation(target, requested, nativeCallOptions);
      } else {
        // auto: AX first; only take a screenshot when AX is insufficient. The
        // second frame (with its own metadata) becomes the latest observation.
        // Insufficient means incomplete, degraded/truncated, OR an empty tree:
        // a complete-but-empty AX view cannot suppress the visual fallback.
        const axOnly = await this.readObservation(
          target,
          { accessibility: true, screenshot: false },
          nativeCallOptions
        );
        const axUsable =
          axOnly.elementsComplete === true &&
          axOnly.degraded !== true &&
          axOnly.truncated !== true &&
          normalizeElements(axOnly.elements).length > 0;
        if (axUsable && !opts?.maxDimension) {
          requested = { accessibility: true, screenshot: false };
          raw = axOnly;
        } else {
          requested = { accessibility: true, screenshot: true };
          raw = await this.readObservation(target, requested, nativeCallOptions);
        }
      }

      this.assertObservationAllowed(deadlineAt, operationSignal, "after native read");
      const stamped = this.stampObservation(raw);
      const view = projectObservation(stamped, opts ?? {}, requested);
      this.assertObservationAllowed(deadlineAt, operationSignal, "after projection");

      if (view.image.status === "usable" || view.image.status === "degraded") {
        let path: string | undefined;
        try {
          path = this.persistImage(stamped);
        } catch (error) {
          const controlError = this.observationControlError(deadlineAt, operationSignal, "while saving the image");
          if (controlError) throw controlError;
          throw error;
        }
        this.assertObservationAllowed(deadlineAt, operationSignal, "after image persistence");
        if (path === undefined) {
          throw new ComputerError(
            "artifact_write_failed",
            "the driver reported an image channel but supplied no usable image artifact"
          );
        }
        view.image = { ...view.image, originalPath: path, ...(view.image.geometry ? { path } : {}) };
        if (view.image.geometry && opts?.maxDimension !== undefined) {
          // Explicit same-frame derived image via system sips; the original
          // PNG stays on disk as evidence. Never upscale. The derivation uses
          // only the remaining request budget for every child process.
          let resized: ResizeResult;
          try {
            const resizePromise = this.options.screenshotResizer
              ? this.options.screenshotResizer(path, opts.maxDimension, {
                signal: operationSignal,
                deadlineAt
              })
              : resizeScreenshot(path, opts.maxDimension, operationSignal, undefined, deadlineAt);
            // A deadline wrapper only reports the caller-visible timeout. The
            // child process cleanup belongs to the derived operation, so keep
            // that promise tracked until it has reaped its child.
            resized = await withDeadline(
              "screenshot derivation",
              this.trackNative(resizePromise, (error) => {
                if (error instanceof ProcessCleanupError) {
                  this.nativeCleanupError = error;
                  this.poisoned = true;
                }
              }),
              Math.max(deadlineAt - Date.now(), 1),
              operationSignal
            );
          } catch (error) {
            if (error instanceof ProcessCleanupError || this.nativeCleanupError) {
              this.poisoned = true;
              throw new ComputerError(
                "cleanup_failed",
                "the screenshot resize process could not be reaped: " +
                  (error instanceof Error ? error.message : String(error))
              );
            }
            const controlError = this.observationControlError(deadlineAt, operationSignal, "during image derivation");
            if (controlError) throw controlError;
            throw new ComputerError(
              "artifact_derivation_failed",
              "the requested screenshot resize failed: " +
                (error instanceof Error ? error.message : String(error))
            );
          }
          this.assertObservationAllowed(deadlineAt, operationSignal, "after image derivation");
          if (resized.path !== path) {
            view.image = {
              ...view.image,
              path: resized.path,
              geometry: {
                ...view.image.geometry!,
                sentWidth: resized.width,
                sentHeight: resized.height
              }
            };
          }
        }
      }

      this.assertObservationAllowed(deadlineAt, operationSignal, "before observation store");
      if (this.options.observationStore) {
        try {
          await withDeadline(
            "observation store save",
            this.options.observationStore.save(view),
            Math.max(deadlineAt - Date.now(), 1),
            operationSignal
          );
        } catch (error) {
          const controlError = this.observationControlError(deadlineAt, operationSignal, "while saving the observation");
          if (controlError) throw controlError;
          if (isTimeoutError(error)) {
            throw new ComputerError("command_timeout", String((error as Error).message));
          }
          throw new ComputerError(
            "observation_store_failed",
            `persisting the observation failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        this.assertObservationAllowed(deadlineAt, operationSignal, "after observation store");
      }

      // This is the publication boundary consumed by host/session callers.
      // Recheck after every await so a request cancelled while its evidence was
      // being saved cannot be recorded as a completed observation.
      this.assertObservationAllowed(deadlineAt, operationSignal, "before publish");
      return view;
    } finally {
      combinedSignal.dispose();
      this.endOp();
    }
  }

  // ---- clickPoint: evidence-bound visual click (A4) -----------------------

  private async clickPoint(target: Target, point: PointClick): Promise<void> {
    const store = this.options.observationStore;
    if (!store) {
      throw new ComputerError("observation_required", "clickPoint requires an observation store — run observe first");
    }
    let observation: Observation;
    try {
      observation = await store.get(point.observationId);
    } catch (error) {
      throw new ComputerError(
        "unknown_observation",
        `observation ${point.observationId} is not usable: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (observation.target.pid !== target.pid || observation.target.windowId !== target.windowId) {
      throw new ComputerError("stale_observation", "observation belongs to a different target");
    }
    if (Date.now() - observation.capturedAt > OBSERVATION_TTL_MS) {
      throw new ComputerError("stale_observation", "observation is older than 60s — observe again");
    }
    if (observation.revision !== this.revision) {
      throw new ComputerError("stale_observation", "a mutation has started since the observation was taken");
    }
    // Fresh-frame validation before EVERY evidence-bound click — including
    // same-epoch clicks. A window can move, resize, navigate, or be changed
    // by the app/user without any local facade mutation; only the CURRENT
    // frame can prove the recorded coordinates still apply (spec §5.2).
    const fresh = await this.readObservation(target, { accessibility: false, screenshot: true });
    if (fresh.pid !== target.pid || fresh.windowId !== target.windowId) {
      throw new ComputerError("stale_observation", "the current frame belongs to a different target — observe again");
    }
    if (fresh.screenshotFrameValid !== true) {
      throw new ComputerError(
        "stale_observation",
        "the current frame's validity is unconfirmed (screenshotFrameValid not true) — observe again"
      );
    }
    const freshPath = this.persistImage(fresh);
    if (
      freshPath === undefined ||
      fresh.windowBounds === undefined ||
      !frameMatchesObservation(observation, {
        windowBounds: fresh.windowBounds,
        pngHash: pngSha256(freshPath)
      })
    ) {
      throw new ComputerError(
        "stale_observation",
        "the window changed since the observation (geometry or pixels) — observe again"
      );
    }
    const geometry = observation.image.geometry;
    if (observation.image.status !== "usable" || !geometry) {
      throw new ComputerError("stale_observation", "observation has no usable image geometry");
    }
    const driverPoint = mapImagePointToDriverPixels({ x: point.x, y: point.y }, geometry);
    if (driverPoint === null) {
      throw new ComputerError(
        "invalid_point",
        `point (${point.x}, ${point.y}) is outside the observation image (${geometry.sentWidth}x${geometry.sentHeight})`
      );
    }
    await this.action("click_point", target, async (b) => b.clickPoint(target, driverPoint));
  }

  // ---- click: fresh lookup on the READ path, then dispatch (A4/F12) ------

  /** AX clicks are lookup-then-dispatch: the exactly-one lookup runs on the
   * read path, so zero/multiple matches or missing element tokens are
   * PRE-DISPATCH failures (not_delivered) — never misclassified as unknown
   * native delivery, and never poisoning the session. */
  private async clickViaToken(
    target: Target,
    predicate: Predicate,
    description: string
  ): Promise<void> {
    return clickUnique(
      {
        snapshot: async () =>
          (await this.read("click lookup", (b) => b.snapshot(target, false))).elements,
        click: async (token) => {
          await this.action("click", target, (b) => b.clickToken(target, token));
        }
      },
      predicate,
      description
    );
  }

  // ---- batch: bounded serial execution (A5) --------------------------------

  private async batch(target: Target, request: BatchRequest, signal?: AbortSignal): Promise<BatchResult> {
    const validated = validateBatch(request);
    // The batch's absolute deadline propagates into EVERY native call made
    // while it runs (reads, actions, waits, final observe) — not just the
    // checks between steps. The request signal is also checked immediately
    // before each native dispatch so cancellation stops undispatched actions.
    const previousDeadline = this.batchDeadlineAt;
    const previousSignal = this.batchSignal;
    const deadline = Date.now() + (validated.timeoutMs ?? DEFAULT_BATCH_TIMEOUT_MS);
    this.batchDeadlineAt = previousDeadline === null ? deadline : Math.min(previousDeadline, deadline);
    this.batchSignal = signal ?? this.options.signal ?? null;
    try {
      return await runBatch(this.computer, target, validated, signal ?? this.options.signal);
    } finally {
      this.batchDeadlineAt = previousDeadline;
      this.batchSignal = previousSignal;
    }
  }

  // ---- actions: unknown delivery poisons; refusals are not_delivered ------

  private async action(
    kind: "click" | "click_point" | "type" | "key" | "scroll",
    target: Target,
    fn: (backend: Backend) => Promise<void | ToolResultLike>
  ): Promise<void> {
    const deadlineAt = this.beginOp();
    try {
      // Shared target ownership (B3): the FIRST mutation of each app acquires
      // the app-level lease; a busy target refuses BEFORE any input dispatch
      // (not_delivered). Read-only paths never acquire.
      await this.ensureLease(target);
      this.assertDispatchAllowed(deadlineAt, "not_delivered");
      // Mutation start invalidates every prior observation immediately.
      this.revision += 1;
      const store = this.options.observationStore;
      if (store) {
        try {
          await store.invalidate(target);
        } catch (error) {
          throw new ComputerError(
            "observation_store_failed",
            `invalidating prior observations failed: ${error instanceof Error ? error.message : String(error)}`,
            "not_delivered"
          );
        }
      }
      let actionStarted = false;
      try {
        await this.options.onAction?.({ phase: "started", kind });
        actionStarted = true;
      } catch (error) {
        throw new ComputerError(
          "event_persist_failed",
          `could not persist action start before dispatch: ${error instanceof Error ? error.message : String(error)}`,
          "not_delivered"
        );
      }
      const finish = async (outcome: "delivered" | "not_delivered" | "unknown"): Promise<void> => {
        try {
          await this.options.onAction?.({ phase: "finished", kind, outcome });
        } catch (error) {
          // The input already crossed the native boundary; an event persistence
          // failure therefore makes its delivery unknown and poisons the
          // session instead of reporting a durable success.
          this.poisoned = true;
          throw new ComputerError(
            "event_persist_failed",
            `could not persist action outcome: ${error instanceof Error ? error.message : String(error)}`,
            "unknown"
          );
        }
      };
      let backend: Backend;
      try {
        backend = await this.ensureReady(deadlineAt);
        // Lease acquisition, observation invalidation, and action-event
        // persistence are all waits. Recheck immediately before crossing the
        // native input boundary; a late request is not delivered just because
        // setup began in time.
        this.assertDispatchAllowed(deadlineAt, "not_delivered");
      } catch (error) {
        const mapped = this.wrapAborted(error);
        if (actionStarted) {
          // Setup failures occur before the action input crosses the native
          // seam. A timed-out driver setup remains unknown conservatively;
          // lifecycle/refusal failures are not_delivered, but every durable
          // action_started event receives a matching finished event.
          const outcome =
            mapped instanceof ComputerError && mapped.code === "command_timeout"
              ? "unknown"
              : mapped instanceof ComputerError && mapped.actionOutcome !== undefined
                ? mapped.actionOutcome
                : "not_delivered";
          await finish(outcome);
        }
        throw mapped;
      }
      try {
        this.assertDispatchAllowed(deadlineAt, "not_delivered");
        const result = await withDeadline(kind, this.trackNative(fn(backend)), Math.max(deadlineAt - Date.now(), 1));
        if (result && typeof result === "object" && result.isError) {
          throw new ComputerError(
            "action_refused",
            `${kind} was refused: ${result.text ?? "no detail"}`,
            "not_delivered"
          );
        }
        await finish("delivered");
      } catch (error) {
        if (isTimeoutError(error)) {
          this.poisoned = true;
          await finish("unknown");
          throw new ComputerError("command_timeout", String((error as Error).message), "unknown");
        }
        if (error instanceof ComputerError && error.actionOutcome !== undefined) {
          await finish(error.actionOutcome);
          throw error;
        }
        const mapped = this.wrapAborted(error);
        if (mapped instanceof ComputerError) {
          // Once fn() has been invoked, an AbortError or other facade error
          // cannot prove that the native input was never delivered.
          this.poisoned = true;
          await finish("unknown");
          throw new ComputerError(mapped.code, mapped.message, "unknown");
        }
        if (isKnownDriverRefusal(error)) {
          await finish("not_delivered");
          throw new ComputerError(
            "action_refused",
            `${kind} was refused by the driver: ${driverErrorDiagnostic(error)}`,
            "not_delivered"
          );
        }
        // Unknown native exception mid-flight: delivery state is unknowable.
        // Conservative unknown + poison — the session refuses further work
        // instead of risking a replay on an unstable driver.
        this.poisoned = true;
        await finish("unknown");
        throw new ComputerError(
          "action_failed",
          `${kind} failed with an unclassified native error: ${driverErrorDiagnostic(error)}`,
          "unknown"
        );
      }
    } finally {
      this.endOp();
    }
  }

  private async ensureLease(target: Target): Promise<void> {
    const leases = this.options.leases;
    if (!leases) return;
    if (this.leaseHandles.has(target.pid)) return;
    let handle: LeaseHandle;
    try {
      handle = await leases.acquire(target);
    } catch (error) {
      if (error instanceof LeaseError) {
        throw new ComputerError(error.code, error.message, "not_delivered");
      }
      throw error;
    }
    this.leaseHandles.set(target.pid, handle);
  }

  private async releaseLeases(): Promise<string[]> {
    const errors: string[] = [];
    const pending = [...this.leaseHandles.values()];
    this.leaseHandles.clear();
    for (const handle of pending) {
      try {
        await handle.release();
      } catch (error) {
        errors.push(`target lease release failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return errors;
  }

  // ---- waitFor: caller-owned overall budget, per-read op caps -------------

  private async waitFor(
    target: Target,
    predicate: (elements: AxElement[]) => boolean,
    description: string,
    opts?: { timeoutMs?: number; intervalMs?: number }
  ): Promise<AxElement[]> {
    const admissionDeadline = this.beginOp(true);
    try {
      // Keep driver setup bounded by one operation even though the polling
      // portion is caller-owned. Once setup has completed, each poll still
      // receives the caller/session absolute cap below.
      const setupDeadline = Math.min(admissionDeadline, Date.now() + OP_LIMIT_MS);
      const backend = await this.ensureReady(setupDeadline);
      const sessionDeadline = Math.min(this.options.deadlineAt ?? Infinity, this.batchDeadlineAt ?? Infinity);
      return await waitForElements(
        {
          snapshot: async () => {
            const perRead = Math.min(sessionDeadline, Date.now() + OP_LIMIT_MS);
            const b = backend;
            try {
              this.assertDispatchAllowed(perRead, "not_delivered");
              const snap = await withDeadline("snapshot", this.trackNative(b.snapshot(target, false)), Math.max(perRead - Date.now(), 1));
              return snap.elements;
            } catch (error) {
              if (isTimeoutError(error)) {
                throw new ComputerError("command_timeout", (error as Error).message);
              }
              throw this.wrapAborted(error);
            }
          }
        },
        predicate,
        description,
        opts
      );
    } finally {
      this.endOp();
    }
  }

  // ---- public surface ------------------------------------------------------

  async metadata(): Promise<{ driverVersion: string; pid: number }> {
    const deadlineAt = this.beginOp();
    try {
      const backend = await this.ensureReady(deadlineAt);
      this.assertDispatchAllowed(deadlineAt);
      if (this.runtimeInfo) return this.runtimeInfo;
      const meta = await withDeadline(
        "metadata",
        this.trackNative(backend.metadata()),
        Math.max(deadlineAt - Date.now(), 1)
      );
      if (meta?.driverVersion === undefined || meta?.pid === undefined) {
        throw new ComputerError("metadata_unavailable", "the driver did not report version/pid");
      }
      this.runtimeInfo = { driverVersion: meta.driverVersion, pid: meta.pid };
      this.notifyRuntime();
      return this.runtimeInfo;
    } finally {
      this.endOp();
    }
  }

  async permissions(): Promise<{ accessibility: boolean; screenRecording: boolean }> {
    const deadlineAt = this.beginOp();
    try {
      const backend = await this.ensureReady(deadlineAt);
      this.assertDispatchAllowed(deadlineAt);
      return this.trackNative(backend.permissions());
    } finally {
      this.endOp();
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    // Closing synchronously rejects new admissions. Existing operations are
    // allowed to finish setup, then fail their final guard; cleanup starts
    // only after those reservations have drained.
    this.closed = true;
    this.closePromise = (async () => {
      const errors: string[] = [];
      const cleanupDeadline = Date.now() + (this.options.cleanupDeadlineMs ?? CLEANUP_BUDGET_MS);
      if (!(await this.waitForAdmissionsIdle(cleanupDeadline))) {
        // A pending lease/setup may still create native state. Do not clean or
        // release ownership underneath it; retaining the lease is safer than
        // allowing another session to race an unresolved operation.
        throw new ComputerError(
          "cleanup_failed",
          "operation admission remained pending after close; target lease retained"
        );
      }
      const backend = this.backend;
      if (backend) {
        errors.push(...(await this.cleanupBackend(backend)));
      }
      // A cleanup API returning does not itself prove an earlier timed-out
      // native call ended. Never release the shared target lease while any
      // backend promise remains unresolved.
      if (!(await this.waitForNativeIdle(Date.now() + (this.options.cleanupDeadlineMs ?? CLEANUP_BUDGET_MS)))) {
        errors.push("native work remained in flight after cleanup; target lease retained");
      }
      if (this.nativeCleanupError) {
        errors.push("derived screenshot cleanup failed: " + this.nativeCleanupError.message + "; target lease retained");
      }
      if (errors.length === 0) {
        errors.push(...(await this.releaseLeases()));
      }
      if (errors.length > 0) {
        throw new ComputerError("cleanup_failed", errors.join("; "));
      }
    })();
    return this.closePromise;
  }

  private async cleanupBackend(backend: Backend): Promise<string[]> {
    const errors: string[] = [];
    const deadline = Date.now() + (this.options.cleanupDeadlineMs ?? CLEANUP_BUDGET_MS);
    const remaining = () => Math.max(deadline - Date.now(), 1);
    for (const [name, step] of [
      ["endSession", () => backend.endSession()],
      ["shutdown", () => backend.shutdown()]
    ] as const) {
      try {
        await withDeadline(name, step(), remaining());
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    try {
      backend.destroy();
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    return errors;
  }
}

export function createSessionWithBackend(
  factory: BackendFactory,
  options: InternalOptions = {}
): ComputerSession {
  return new SessionImpl(factory, options);
}
