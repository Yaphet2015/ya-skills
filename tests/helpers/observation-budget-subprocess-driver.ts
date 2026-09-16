import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createObservationStore,
  createSessionWithBackend,
  type Backend,
  type NativeObservationLike,
  type ObservationStore,
  type ObserveCallOptions,
  type Target
} from "../../packages/computer-runtime/src/index.js";
import type { DriverConfig, DriverSessionLike } from "../../packages/computer-session/src/driver-worker.js";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function delayedStore(root: string): ObservationStore {
  const controlDir = join(root, "observation-budget");
  const startedPath = join(controlDir, "store-started");
  const releasePath = join(controlDir, "release-store");
  const persistent = createObservationStore(join(root, "observations"));
  return {
    async save(value) {
      mkdirSync(controlDir, { recursive: true, mode: 0o700 });
      writeFileSync(startedPath, "started", { mode: 0o600 });
      while (!existsSync(releasePath)) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await persistent.save(value);
    },
    get: persistent.get,
    invalidate: persistent.invalidate
  };
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
    metadata: async () => ({ driverVersion: "observation-budget-subprocess", pid: process.pid }),
    permissions: async () => ({ accessibility: true, screenRecording: true }),
    endSession: async () => undefined,
    shutdown: async () => undefined,
    destroy: () => undefined
  };
}

/** A real driver-worker module fixture. It creates the production runtime in
 * the child process, then delays only ObservationStore.save behind a file
 * handshake so the parent can exercise host -> IPC -> worker cancellation. */
export function createObservationBudgetSubprocessDriver(config: DriverConfig): DriverSessionLike {
  const root = process.env.YK_CU_SESSION_ROOT;
  if (!root) throw new Error("YK_CU_SESSION_ROOT is required");
  const target: Target = { pid: config.target.pid, windowId: BigInt(config.target.windowId) };
  const session = createSessionWithBackend(
    { load: async () => ({}), create: async () => backendFor(target) },
    {
      artifactsDir: join(root, "artifacts"),
      observationStore: delayedStore(root)
    }
  );
  return {
    async call(method, args, signal) {
      if (method !== "observe") throw new Error(`unexpected driver method ${method}`);
      const rawDeadline = args.deadlineAt;
      const deadlineAt = typeof rawDeadline === "number" && Number.isFinite(rawDeadline)
        ? rawDeadline
        : undefined;
      const callOptions: ObserveCallOptions = {
        ...(signal !== undefined ? { signal } : {}),
        ...(deadlineAt !== undefined ? { deadlineAt } : {})
      };
      return session.computer.observe(target, args.options as never, callOptions);
    },
    async close() {
      await session.close();
    }
  };
}
