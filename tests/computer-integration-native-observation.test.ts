import { describe, expect, test } from "bun:test";
import {
  ComputerError,
  createSessionWithBackend,
  type Backend
} from "../packages/computer-runtime/src/session.js";
import type { NativeObservationLike } from "../packages/computer-runtime/src/types.js";

const TARGET = { pid: 4242, windowId: 12345n };

function backendWithObservation(
  observe: Backend["observe"]
): Backend {
  return {
    apps: async () => [],
    windows: async () => [],
    snapshot: async () => ({ elements: [], title: "" }),
    observe,
    clickToken: async () => ({ isError: false }),
    clickPoint: async () => ({ isError: false }),
    type: async () => ({ isError: false }),
    key: async () => ({ isError: false }),
    scroll: async () => ({ isError: false }),
    metadata: async () => ({ driverVersion: "test", pid: process.pid }),
    permissions: async () => ({ accessibility: true, screenRecording: true }),
    endSession: async () => undefined,
    shutdown: async () => undefined,
    destroy: () => undefined
  };
}

const rawObservation = (): NativeObservationLike => ({
  pid: TARGET.pid,
  windowId: TARGET.windowId,
  elements: [],
  elementsComplete: true,
  windowTitle: "test",
  observationId: "raw",
  capturedAt: 0,
  epoch: "raw",
  revision: 0
});

describe("native observation deadline/cancellation propagation", () => {
  test("per-call observe signal reaches the backend and aborts its wait", async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });

    const backend = backendWithObservation(async (_target, _channels, callOptions) => {
      seenSignal = callOptions?.signal;
      started();
      await pending;
      return rawObservation();
    });
    const session = createSessionWithBackend(
      { load: async () => ({}), create: async () => backend },
      { cleanupDeadlineMs: 500 }
    );

    const request = session.computer.observe(TARGET, { mode: "ax" }, controller.signal);
    await startedPromise;
    expect(seenSignal).toBe(controller.signal);
    controller.abort();

    const error = await request.then(() => null, (value: unknown) => value);
    expect(error).toBeInstanceOf(ComputerError);
    expect((error as ComputerError).code).toBe("aborted");

    release();
    await request.catch(() => undefined);
    await session.close();
  });

  test("per-call absolute deadline reaches the backend and bounds observation", async () => {
    let seenDeadline: number | undefined;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const backend = backendWithObservation(async (_target, _channels, callOptions) => {
      seenDeadline = callOptions?.deadlineAt;
      await pending;
      return rawObservation();
    });
    const session = createSessionWithBackend(
      { load: async () => ({}), create: async () => backend },
      { cleanupDeadlineMs: 500 }
    );
    const deadlineAt = Date.now() + 20;

    const request = session.computer.observe(TARGET, { mode: "ax" }, { deadlineAt });
    const error = await request.then(() => null, (value: unknown) => value);
    expect(error).toBeInstanceOf(ComputerError);
    expect((error as ComputerError).code).toBe("command_timeout");
    expect(seenDeadline).toBe(deadlineAt);

    release();
    await request.catch(() => undefined);
    await session.close();
  });
});
