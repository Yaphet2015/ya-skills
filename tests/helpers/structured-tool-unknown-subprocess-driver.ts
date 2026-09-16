import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createSessionWithBackend,
  type Backend,
  type BatchRequest,
  type ObserveOptions,
  type Target
} from "@ya-skills/computer-runtime";
import type { DriverConfig, DriverSessionLike } from "@ya-skills/computer-session";

interface Counts {
  type: number;
  key: number;
}

let counts: Counts = { type: 0, key: 0 };

function record(kind: keyof Counts): void {
  const root = process.env.YK_CU_SESSION_ROOT;
  if (root === undefined) throw new Error("YK_CU_SESSION_ROOT is required by this fixture");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  counts = { ...counts, [kind]: counts[kind] + 1 };
  writeFileSync(join(root, "structured-tool-calls.json"), JSON.stringify(counts), { mode: 0o600 });
}

/** Mimics the SDK's structured DriverError.Tool shape. A Tool exception does
 * not prove whether native input reached the application, so the runtime must
 * return an unknown receipt and poison the session. */
function structuredToolError(): Error {
  const error = new Error("the injected Tool error has unknown delivery");
  Object.assign(error, {
    name: "DriverError.Tool",
    tag: "Tool",
    inner: {
      errorCode: "tool_delivery_unknown",
      message: "the driver could not confirm whether the input reached the app"
    }
  });
  return error;
}

function makeBackend(): Backend {
  return {
    apps: async () => [],
    windows: async () => [],
    snapshot: async () => ({ elements: [], title: "fixture" }),
    observe: async (target: Target) => ({
      pid: target.pid,
      windowId: target.windowId,
      elements: [],
      elementsComplete: true,
      windowTitle: "fixture",
      observationId: "structured-tool-observation",
      capturedAt: Date.now(),
      epoch: "structured-tool-fixture",
      revision: 0
    }),
    clickToken: async () => ({ isError: false }),
    clickPoint: async () => ({ isError: false }),
    type: async () => {
      record("type");
      throw structuredToolError();
    },
    key: async () => {
      record("key");
      return { isError: false };
    },
    scroll: async () => ({ isError: false }),
    metadata: async () => ({ driverVersion: "structured-tool-fixture", pid: process.pid }),
    permissions: async () => ({ accessibility: true, screenRecording: true }),
    endSession: async () => undefined,
    shutdown: async () => undefined,
    destroy: () => undefined
  };
}

/** Test-only module loaded by the real driver-worker subprocess. The action
 * still passes through createSessionWithBackend and runBatch in that child. */
export function createStructuredToolUnknownSubprocessDriver(config: DriverConfig): DriverSessionLike {
  const target: Target = { pid: config.target.pid, windowId: BigInt(config.target.windowId) };
  const session = createSessionWithBackend(
    { load: async () => ({}), create: async () => makeBackend() },
    { onAction: config.onAction }
  );
  return {
    async call(method, args, signal) {
      if (method === "batch") {
        return session.computer.batch(target, args.request as BatchRequest, signal);
      }
      if (method === "observe") {
        return session.computer.observe(target, args.options as ObserveOptions, signal);
      }
      await session.close();
      return null;
    },
    async close() {
      await session.close();
    },
    initCount: 1
  };
}
