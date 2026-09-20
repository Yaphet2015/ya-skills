import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createObservationStore,
  createSessionWithBackend,
  type Backend,
  type ComputerSession,
  type NativeObservationLike,
  type Point,
  type Target
} from "@ya-skills/computer-runtime";
import { SYNTHETIC_PNG_BASE64 } from "./computer-fixtures.js";

// This helper owns a synthetic runtime fixture for the E2E control lane. It
// deliberately does not use the shared session-worker fixture: every test
// receives its own directory, target identity, observation frames, and action
// counters, while the production ComputerSession remains the code under test.
let fixtureNumber = 0;

export interface E2ELaneRuntimeOptions {
  keyDelayMs?: number;
}

export interface E2ELaneRuntimeFixture {
  root: string;
  target: Target;
  session: ComputerSession;
  pointClicks: Point[];
  keyCalls: string[];
  observeRequests: Array<{ accessibility: boolean; screenshot: boolean }>;
  close(): Promise<void>;
}

export async function createE2ELaneRuntimeFixture(
  options: E2ELaneRuntimeOptions = {}
): Promise<E2ELaneRuntimeFixture> {
  const root = await mkdtemp(join(tmpdir(), "yk-e2e-lane-runtime-"));
  const n = ++fixtureNumber;
  // This PID is synthetic and is never passed to a process-killing API. The
  // per-fixture value keeps target identity distinct if tests overlap.
  const target: Target = { pid: 4_700_000 + n, windowId: BigInt(8_100_000 + n) };
  const pointClicks: Point[] = [];
  const keyCalls: string[] = [];
  const observeRequests: Array<{ accessibility: boolean; screenshot: boolean }> = [];
  let frameNumber = 0;

  const backend: Backend = {
    apps: async () => [],
    windows: async () => [],
    snapshot: async () => ({ title: "Lane fixture", elements: [] }),
    observe: async (requestedTarget, options): Promise<NativeObservationLike> => {
      if (requestedTarget.pid !== target.pid || requestedTarget.windowId !== target.windowId) {
        throw new Error("lane fixture received an unexpected target");
      }
      observeRequests.push({ accessibility: options.accessibility, screenshot: options.screenshot });
      frameNumber += 1;
      return {
        pid: target.pid,
        windowId: target.windowId,
        snapshotId: `lane-frame-${frameNumber}`,
        windowTitle: "Lane fixture",
        elements: [
          {
            elementIndex: 0n,
            role: "AXButton",
            label: "Visual anchor",
            elementToken: "lane-visual-anchor",
            frame: { x: 100, y: 80, w: 60, h: 24 }
          }
        ],
        totalElementCount: 1n,
        returnedElementCount: 1n,
        filteredElementCount: 1n,
        elementsComplete: true,
        screenshotWidth: 1280,
        screenshotHeight: 800,
        screenshotScale: 2,
        screenshotMimeType: "image/png",
        screenshotFrameValid: true,
        windowBounds: { x: 80, y: 40, width: 640, height: 400 },
        images: options.screenshot ? [{ mimeType: "image/png", dataBase64: SYNTHETIC_PNG_BASE64 }] : [],
        observationId: `lane-raw-${frameNumber}`,
        capturedAt: Date.now(),
        epoch: "lane-raw-epoch",
        revision: 0
      };
    },
    clickToken: async () => ({ isError: false }),
    clickPoint: async (requestedTarget, point) => {
      if (requestedTarget.pid !== target.pid || requestedTarget.windowId !== target.windowId) {
        throw new Error("lane fixture received an unexpected click target");
      }
      pointClicks.push(point);
      return { isError: false };
    },
    type: async () => ({ isError: false }),
    key: async (_requestedTarget, key) => {
      keyCalls.push(key);
      if ((options.keyDelayMs ?? 0) > 0) {
        await new Promise((resolve) => setTimeout(resolve, options.keyDelayMs));
      }
      return { isError: false };
    },
    scroll: async () => ({ isError: false }),
    metadata: async () => ({ driverVersion: "e2e-lane-fake", pid: target.pid }),
    permissions: async () => ({ accessibility: true, screenRecording: true }),
    endSession: async () => undefined,
    shutdown: async () => undefined,
    destroy: () => undefined
  };

  const session = createSessionWithBackend(
    {
      load: async () => ({ lane: true }),
      create: async () => backend
    },
    {
      artifactsDir: join(root, "artifacts"),
      observationStore: createObservationStore(join(root, "observations"))
    }
  );

  return {
    root,
    target,
    session,
    pointClicks,
    keyCalls,
    observeRequests,
    async close() {
      try {
        await session.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  };
}
