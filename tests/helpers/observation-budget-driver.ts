import {
  createSessionWithBackend,
  type Backend,
  type NativeObservationLike,
  type ObservationStore,
  type SessionOptions,
  type Target
} from "@ya-skills/computer-runtime";
import type { DriverConfig, DriverSessionLike } from "../../packages/computer-session/src/driver-worker.js";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

type Setup = {
  target: Target;
  artifactsDir: string;
  observationStore: ObservationStore;
  screenshotResizer?: SessionOptions["screenshotResizer"];
};

const setups = new Map<string, Setup>();

export function configureObservationBudgetDriver(sessionId: string, setup: Setup): void {
  setups.set(sessionId, setup);
}

export function clearObservationBudgetDriver(sessionId: string): void {
  setups.delete(sessionId);
}

function backendFor(target: Target): Backend {
  const rawObservation = (options: { screenshot: boolean }): NativeObservationLike => ({
    pid: target.pid,
    windowId: target.windowId,
    elements: [],
    elementsComplete: true,
    screenshotWidth: 1280,
    screenshotHeight: 800,
    screenshotFrameValid: true,
    windowBounds: { x: 80, y: 40, width: 640, height: 400 },
    images: options.screenshot ? [{ mimeType: "image/png", dataBase64: PNG_BASE64 }] : [],
    observationId: "raw",
    capturedAt: 0,
    epoch: "raw",
    revision: 0
  });
  return {
    apps: async () => [],
    windows: async () => [],
    snapshot: async () => ({ elements: [], title: "" }),
    observe: async (_target, options) => rawObservation(options),
    clickToken: async () => ({ isError: false }),
    clickPoint: async () => ({ isError: false }),
    type: async () => ({ isError: false }),
    key: async () => ({ isError: false }),
    scroll: async () => ({ isError: false }),
    metadata: async () => ({ driverVersion: "observation-budget-driver", pid: process.pid }),
    permissions: async () => ({ accessibility: true, screenRecording: true }),
    endSession: async () => undefined,
    shutdown: async () => undefined,
    destroy: () => undefined
  };
}

/** Inject a production ComputerSession behind the driver-worker factory seam.
 * This keeps the test desktop-free while traversing buildDriverSession and the
 * same DriverSessionLike.call contract used by the worker. */
export function createObservationBudgetDriver(config: DriverConfig): DriverSessionLike {
  const setup = setups.get(config.sessionId);
  if (!setup) throw new Error(`no observation budget setup for ${config.sessionId}`);
  const session = createSessionWithBackend(
    { load: async () => ({}), create: async () => backendFor(setup.target) },
    {
      artifactsDir: setup.artifactsDir,
      observationStore: setup.observationStore,
      ...(setup.screenshotResizer ? { screenshotResizer: setup.screenshotResizer } : {})
    }
  );
  return {
    async call(method, args, signal) {
      if (method !== "observe") throw new Error(`unexpected driver method ${method}`);
      const rawDeadline = args.deadlineAt;
      const deadlineAt = typeof rawDeadline === "number" && Number.isFinite(rawDeadline)
        ? rawDeadline
        : undefined;
      return session.computer.observe(
        setup.target,
        args.options as never,
        { signal, ...(deadlineAt !== undefined ? { deadlineAt } : {}) }
      );
    },
    async close() {
      await session.close();
    }
  };
}
