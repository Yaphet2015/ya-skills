// Exactly-one matching, the single stale-token recovery, and postcondition
// polling. Every replay re-observes; element tokens are never persisted.

import type { AxElement, Predicate } from "./types.js";
import { ComputerError } from "./session.js";

// One bounded retry for stale-token refusals only (official contract: the
// action was never delivered — retry is recovery, NOT replay); any other
// error fails immediately. The refusal code lives in the typed errorCode
// field, never in the error message string.
export async function clickUnique(
  deps: { snapshot(): Promise<AxElement[]>; click(token: string): Promise<void> },
  predicate: Predicate,
  description: string
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const matches = (await deps.snapshot()).filter(predicate);
    if (matches.length !== 1) {
      // Pre-dispatch lookup failure: nothing was sent to the driver, so the
      // outcome is not_delivered — never unknown native delivery.
      throw new ComputerError(
        "no_unique_match",
        `expected exactly one ${description}, found ${matches.length} — refine the selector or re-observe`,
        "not_delivered"
      );
    }
    const token = matches[0]!.elementToken;
    if (!token) {
      throw new ComputerError(
        "no_unique_match",
        `matched element has no elementToken (${description}) — re-observe and retry`,
        "not_delivered"
      );
    }
    try {
      await deps.click(token);
      return;
    } catch (error) {
      const e = (typeof error === "object" && error !== null ? error : {}) as {
        errorCode?: string;
        inner?: { errorCode?: string };
      };
      if (attempt === 0 && (e.errorCode ?? e.inner?.errorCode) === "stale_element_token") continue;
      throw error;
    }
  }
}

export const DEFAULT_INTERVAL_MS = 500;
export const DEFAULT_TIMEOUT_MS = 30_000;

export interface WaitForDeps {
  snapshot(): Promise<AxElement[]>;
}

export interface WaitForOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /** @internal test-injected clock */
  sleepFn?: (ms: number) => Promise<void>;
  /** @internal test-injected clock */
  now?: () => number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Poll fresh snapshots until the caller's predicate holds. Only
// degraded_snapshot counts as a transient miss — permission errors and the
// like rethrow immediately instead of being swallowed into the polling loop.
// The overall budget is the caller's timeoutMs (NOT capped at one 30s op);
// each underlying read is budgeted separately by the session layer.
export async function waitForElements(
  deps: WaitForDeps,
  predicate: (elements: AxElement[]) => boolean,
  description: string,
  opts: WaitForOptions = {}
): Promise<AxElement[]> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const doSleep = opts.sleepFn ?? sleep;
  const now = opts.now ?? Date.now;
  const deadlineAt = now() + timeoutMs;
  for (;;) {
    let elements: AxElement[];
    try {
      elements = await deps.snapshot();
    } catch (error) {
      if (error instanceof ComputerError && error.code === "degraded_snapshot" && now() < deadlineAt) {
        await doSleep(intervalMs);
        continue;
      }
      throw error;
    }
    if (predicate(elements)) return elements;
    if (now() >= deadlineAt) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for: ${description}`);
    }
    await doSleep(intervalMs);
  }
}
