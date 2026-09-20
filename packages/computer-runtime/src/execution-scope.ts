import { combineAbortSignals } from "./operation-control.js";

/** Request-local lifetime. Deadlines only get shorter as work enters children.
 * Expiry policy belongs to the owner: timing out a wait cannot prove that a
 * native operation stopped, and cancellation must not erase that distinction. */
export interface ExecutionScope {
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  remainingMs(): number;
  child(options?: ExecutionScopeOptions): ExecutionScope;
  onDeadline(expire: () => void): void;
  abort(reason?: unknown): void;
  dispose(): void;
}

export interface ExecutionScopeOptions {
  deadlineAt?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  parent?: ExecutionScope;
}

export function createExecutionScope(options: ExecutionScopeOptions = {}): ExecutionScope {
  const deadlineAt = Math.min(
    options.parent?.deadlineAt ?? Infinity,
    options.deadlineAt ?? Infinity,
    options.timeoutMs === undefined ? Infinity : Date.now() + options.timeoutMs
  );
  const controller = new AbortController();
  const cancellation = combineAbortSignals([options.parent?.signal, options.signal, controller.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const scope: ExecutionScope = {
    deadlineAt,
    signal: cancellation.signal!,
    remainingMs: () => Math.max(0, deadlineAt - Date.now()),
    child: (child = {}) => createExecutionScope({ ...child, parent: scope }),
    onDeadline(expire) {
      if (timer !== undefined) clearTimeout(timer);
      if (Number.isFinite(deadlineAt)) timer = setTimeout(expire, scope.remainingMs());
    },
    abort: (reason) => controller.abort(reason),
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      cancellation.dispose();
    }
  };
  return scope;
}
