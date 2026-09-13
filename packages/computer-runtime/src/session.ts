// Lazy driver session: one absolute deadline per native operation shared by
// load/create/work, signal + poison guards, idempotent ordered close. The
// session facade turns backend ToolResults and timeouts into ComputerError.

import type {
  AppRef,
  AxElement,
  Backend,
  BackendFactory,
  Computer,
  Predicate,
  ScrollSpec,
  Snapshot,
  Target,
  ToolResultLike,
  WindowRef
} from "./types.js";
import { clickUnique, waitForElements } from "./actions.js";

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

export interface SessionOptions {
  onRuntime?: (info: { driverVersion: string; pid: number }) => void;
  signal?: AbortSignal;
  deadlineAt?: number;
  onAction?: (event: {
    phase: "started" | "finished";
    kind: "click" | "type" | "key" | "scroll";
    outcome?: "delivered" | "not_delivered" | "unknown";
  }) => void;
}

export interface ComputerSession {
  computer: Computer;
  metadata(): Promise<{ driverVersion: string; pid: number }>;
  permissions(): Promise<{ accessibility: boolean; screenRecording: boolean }>;
  close(): Promise<void>;
}

interface InternalOptions extends SessionOptions {
  cleanupDeadlineMs?: number;
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && /timed out/.test(error.message);
}

function withDeadline<T>(label: string, promise: Promise<T>, deadlineMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${deadlineMs}ms`));
    }, deadlineMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
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
      click: (target: Target, predicate: Predicate, description: string) =>
        this.action("click", async (b) => {
          await clickUnique(
            {
              snapshot: async () => (await b.snapshot(target, false)).elements,
              click: async (token) => {
                await b.clickToken(target, token);
              }
            },
            predicate,
            description
          );
        }),
      type: (target: Target, text: string) => this.action("type", (b) => b.type(target, text)),
      key: (target: Target, key: string, modifiers?: string[]) =>
        this.action("key", (b) => b.key(target, key, modifiers)),
      scroll: (target: Target, spec: ScrollSpec) => this.action("scroll", (b) => b.scroll(target, spec)),
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
    if (this.options.signal?.aborted) {
      throw new ComputerError("aborted", "the operation was aborted");
    }
    const cap = uncapped ? Infinity : OP_LIMIT_MS;
    return Math.min(this.options.deadlineAt ?? Infinity, Date.now() + cap);
  }

  private wrapAborted(error: unknown): unknown {
    if (error instanceof Error && error.name === "AbortError") {
      return new ComputerError("aborted", "the operation was aborted");
    }
    return error;
  }

  private async ensureReady(deadlineAt: number): Promise<Backend> {
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
      sdk = await withDeadline("sdk load", this.factory.load(), remaining());
    } catch (error) {
      if (isTimeoutError(error)) this.poisoned = true;
      throw this.wrapAborted(error);
    }
    const createPromise = this.factory.create(sdk);
    let backend: Backend;
    try {
      backend = await withDeadline("driver create", createPromise, remaining());
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
      const meta = await withDeadline("metadata", backend.metadata(), remaining());
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

  private async read<T>(label: string, fn: (backend: Backend) => Promise<T>): Promise<T> {
    const deadlineAt = this.beginOp();
    const backend = await this.ensureReady(deadlineAt);
    try {
      return await withDeadline(label, fn(backend), Math.max(deadlineAt - Date.now(), 1));
    } catch (error) {
      if (isTimeoutError(error)) {
        throw new ComputerError("command_timeout", (error as Error).message);
      }
      throw this.wrapAborted(error);
    }
  }

  // ---- actions: unknown delivery poisons; refusals are not_delivered ------

  private async action(
    kind: "click" | "type" | "key" | "scroll",
    fn: (backend: Backend) => Promise<void | ToolResultLike>
  ): Promise<void> {
    const deadlineAt = this.beginOp();
    this.options.onAction?.({ phase: "started", kind });
    const finish = (outcome: "delivered" | "not_delivered" | "unknown") =>
      this.options.onAction?.({ phase: "finished", kind, outcome });
    let backend: Backend;
    try {
      backend = await this.ensureReady(deadlineAt);
    } catch (error) {
      const mapped = this.wrapAborted(error);
      if (mapped instanceof ComputerError && mapped.code === "command_timeout") {
        finish("unknown");
      }
      throw mapped;
    }
    try {
      const result = await withDeadline(kind, fn(backend), Math.max(deadlineAt - Date.now(), 1));
      if (result && typeof result === "object" && result.isError) {
        throw new ComputerError(
          "action_refused",
          `${kind} was refused: ${result.text ?? "no detail"}`,
          "not_delivered"
        );
      }
      finish("delivered");
    } catch (error) {
      if (isTimeoutError(error)) {
        this.poisoned = true;
        finish("unknown");
        throw new ComputerError("command_timeout", String((error as Error).message), "unknown");
      }
      // Every non-timeout failure here means nothing was delivered.
      finish("not_delivered");
      throw this.wrapAborted(error);
    }
  }

  // ---- waitFor: caller-owned overall budget, per-read op caps -------------

  private async waitFor(
    target: Target,
    predicate: (elements: AxElement[]) => boolean,
    description: string,
    opts?: { timeoutMs?: number; intervalMs?: number }
  ): Promise<AxElement[]> {
    this.beginOp(true); // guards only — the overall budget is the caller's
    const backend = await this.ensureReady(this.beginOp());
    const sessionDeadline = this.options.deadlineAt ?? Infinity;
    return waitForElements(
      {
        snapshot: async () => {
          const perRead = Math.min(sessionDeadline, Date.now() + OP_LIMIT_MS);
          const b = backend;
          try {
            const snap = await withDeadline("snapshot", b.snapshot(target, false), Math.max(perRead - Date.now(), 1));
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
  }

  // ---- public surface ------------------------------------------------------

  async metadata(): Promise<{ driverVersion: string; pid: number }> {
    const deadlineAt = this.beginOp();
    const backend = await this.ensureReady(deadlineAt);
    if (this.runtimeInfo) return this.runtimeInfo;
    const meta = await withDeadline(
      "metadata",
      backend.metadata(),
      Math.max(deadlineAt - Date.now(), 1)
    );
    if (meta?.driverVersion === undefined || meta?.pid === undefined) {
      throw new ComputerError("metadata_unavailable", "the driver did not report version/pid");
    }
    this.runtimeInfo = { driverVersion: meta.driverVersion, pid: meta.pid };
    this.notifyRuntime();
    return this.runtimeInfo;
  }

  async permissions(): Promise<{ accessibility: boolean; screenRecording: boolean }> {
    const deadlineAt = this.beginOp();
    const backend = await this.ensureReady(deadlineAt);
    return backend.permissions();
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const backend = this.backend;
    this.closePromise = (async () => {
      if (!backend) return;
      const errors = await this.cleanupBackend(backend);
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
