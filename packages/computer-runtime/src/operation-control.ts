import type { ObserveCallOptions } from "./types.js";
import { ComputerError } from "./driver-result.js";

export function normalizeObserveCallOptions(callOptions?: ObserveCallOptions | AbortSignal): ObserveCallOptions {
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
export function combineAbortSignals(signals: Array<AbortSignal | undefined>): CombinedAbortSignal {
  const unique = [...new Set(signals.filter((signal): signal is AbortSignal => signal !== undefined))];
  if (unique.length === 0) return { dispose() {} };
  if (unique.length === 1) return { signal: unique[0], dispose() {} };

  const controller = new AbortController();
  const listeners = unique.map((signal) => {
    const onAbort = () => controller.abort(signal.reason);
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

export function withDeadline<T>(label: string, promise: Promise<T>, deadlineMs: number, signal?: AbortSignal): Promise<T> {
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
