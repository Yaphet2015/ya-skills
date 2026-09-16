import { describe, expect, test } from "bun:test";
import {
  ComputerError,
  createSessionWithBackend,
  resizeScreenshot,
  type Backend,
  type NativeObservationLike,
  type Observation,
  type ObservationStore,
  type ProcessRunner
} from "../packages/computer-runtime/src/index.js";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SYNTHETIC_PNG_BASE64 } from "./helpers/computer-fixtures.js";
import { buildDriverSession } from "../packages/computer-session/src/driver-worker.js";
import { startHost, sendControl, sendRequest, type HostConfig } from "../packages/computer-session/src/index.js";
import type { SessionRequest } from "../packages/computer-session/src/types.js";
import {
  clearObservationBudgetDriver,
  configureObservationBudgetDriver
} from "./helpers/observation-budget-driver.js";

const TARGET = { pid: 4242, windowId: 12345n };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) await sleep(10);
  if (!existsSync(path)) throw new Error(`timed out waiting for ${path}`);
}

function rawObservation(): NativeObservationLike {
  return {
    pid: TARGET.pid,
    windowId: TARGET.windowId,
    elements: [],
    elementsComplete: true,
    screenshotWidth: 1280,
    screenshotHeight: 800,
    screenshotFrameValid: true,
    windowBounds: { x: 80, y: 40, width: 640, height: 400 },
    images: [{ mimeType: "image/png", dataBase64: SYNTHETIC_PNG_BASE64 }],
    observationId: "raw",
    capturedAt: 0,
    epoch: "raw",
    revision: 0
  };
}

function backendWithObservation(): Backend {
  return {
    apps: async () => [],
    windows: async () => [],
    snapshot: async () => ({ elements: [], title: "" }),
    observe: async () => rawObservation(),
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

function delayedStore() {
  let saved: Observation | undefined;
  let resolveSave!: () => void;
  let saveStarted!: () => void;
  const started = new Promise<void>((resolve) => (saveStarted = resolve));
  const release = new Promise<void>((resolve) => (resolveSave = resolve));
  const store: ObservationStore = {
    async save(value) {
      saveStarted();
      await release;
      saved = value;
    },
    async get() {
      if (!saved) throw new Error("observation was not saved");
      return saved;
    },
    async invalidate() {
      saved = undefined;
    }
  };
  return { store, started, release: resolveSave };
}

function makeSession(options: Record<string, unknown> = {}) {
  return createSessionWithBackend(
    { load: async () => ({}), create: async () => backendWithObservation() },
    { artifactsDir: "/tmp/ya-observation-budget-artifacts", ...options } as never
  );
}

describe("observation request budget finalization", () => {
  test("cancellation during store.save stays interrupted after save resolves", async () => {
    const controller = new AbortController();
    const delayed = delayedStore();
    const session = makeSession({ observationStore: delayed.store });
    const request = session.computer.observe(TARGET, { mode: "image" }, controller.signal);

    await delayed.started;
    controller.abort();
    delayed.release();

    const error = await request.then(() => null, (value: unknown) => value);
    expect(error).toBeInstanceOf(ComputerError);
    expect((error as ComputerError).code).toBe("aborted");
    expect((error as ComputerError).code).not.toBe("observation_store_failed");
    await session.close();
  });

  test("deadline remains active while store.save is pending", async () => {
    const delayed = delayedStore();
    const session = makeSession({ observationStore: delayed.store });
    const deadlineAt = Date.now() + 100;
    const request = session.computer.observe(TARGET, { mode: "image" }, { deadlineAt });
    const outcome = request.then(() => null, (value: unknown) => value);

    await delayed.started;
    while (Date.now() < deadlineAt) await sleep(1);
    delayed.release();

    const error = await outcome;
    expect(error).toBeInstanceOf(ComputerError);
    expect((error as ComputerError).code).toBe("command_timeout");
    await session.close();
  });
});

describe("derived screenshot request budget", () => {
  test("passes only the remaining deadline to each child process and fails after expiry", async () => {
    const calls: Array<{ args: string[]; timeoutMs: number }> = [];
    const runner: ProcessRunner = async (_command, args, options) => {
      calls.push({ args, timeoutMs: options.timeoutMs });
      await sleep(30);
      return {
        stdout: args[0] === "-g" ? "pixelWidth: 2880\npixelHeight: 1800\n" : "pixelWidth: 1440\npixelHeight: 900\n",
        stderr: "",
        code: 0
      };
    };
    const deadlineAt = Date.now() + 50;
    const error = await resizeScreenshot("/tmp/missing-observation.png", 1440, undefined, runner, deadlineAt)
      .then(() => null, (value: unknown) => value);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/deadline|timed out/i);
    expect(calls[0]?.timeoutMs).toBeLessThanOrEqual(50);
  });

  test("cancellation during a child process remains an interruption signal", async () => {
    const controller = new AbortController();
    const runner: ProcessRunner = async () => {
      await sleep(30);
      return { stdout: "pixelWidth: 100\npixelHeight: 80\n", stderr: "", code: 0 };
    };
    const request = resizeScreenshot("/tmp/missing-observation.png", 1440, controller.signal, runner);
    setTimeout(() => controller.abort(), 5);
    await expect(request).rejects.toThrow(/aborted|cancel/i);
  });
});

describe("host-style observation finalization", () => {
  test("real host and driver-worker IPC preserve interrupted final observation", async () => {
    const root = await mkdtemp(join(tmpdir(), "cu-observe-budget-ipc-"));
    const sessionId = randomUUID();
    const generation = randomUUID();
    const target = { pid: 4_242_424, windowId: "12345" };
    const socketPath = join(tmpdir(), `cu-obs-${sessionId.replace(/-/g, "").slice(0, 12)}.sock`);
    const config: HostConfig = {
      schemaVersion: 1,
      sessionId,
      generation,
      target,
      root,
      socketPath,
      idleTimeoutMs: 120_000,
      requestsDir: join(root, "requests"),
      driver: {
        kind: "module",
        path: join(import.meta.dir, "helpers/observation-budget-subprocess-driver.ts"),
        export: "createObservationBudgetSubprocessDriver"
      }
    };
    let host: Awaited<ReturnType<typeof startHost>> | undefined;
    const requestId = "observe-cancel-ipc";
    const request: SessionRequest = {
      schemaVersion: 1,
      sessionId,
      generation,
      requestId,
      operation: { kind: "observe", options: { mode: "image" } }
    };
    const startedPath = join(root, "observation-budget", "store-started");
    const releasePath = join(root, "observation-budget", "release-store");
    try {
      host = await startHost(config);
      const replyPromise = sendRequest(socketPath, request, 10_000);
      await waitForFile(startedPath);
      const cancel = await sendControl(
        socketPath,
        { kind: "cancel", schemaVersion: 1, sessionId, requestId },
        5_000
      );
      expect(cancel.error).toBeUndefined();
      await writeFile(releasePath, "release", { mode: 0o600 });
      const reply = await replyPromise;
      expect(reply.status).toBe("interrupted");
      expect(reply.error?.code).toBe("aborted");

      const journalPath = join(root, sessionId, "requests", requestId, "events.jsonl");
      const events = (await readFile(journalPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type: string; payload: { status?: string } });
      const terminal = events.filter((event) => event.type === "request_finished");
      expect(terminal).toHaveLength(1);
      expect(terminal[0]?.payload.status).toBe("interrupted");
      expect(terminal.some((event) => event.payload.status === "completed")).toBe(false);
    } finally {
      await writeFile(releasePath, "release", { mode: 0o600 }).catch(() => undefined);
      await host?.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
      await rm(socketPath, { force: true }).catch(() => undefined);
    }
  }, 30_000);

  test("driver-worker factory forwards cancellation through production runtime finalization", async () => {
    const controller = new AbortController();
    const dir = await mkdtemp(join(tmpdir(), "cu-observe-budget-worker-"));
    const sessionId = `budget-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const delayed = delayedStore();
    configureObservationBudgetDriver(sessionId, {
      target: TARGET,
      artifactsDir: dir,
      observationStore: delayed.store
    });
    const driver = await buildDriverSession({
      sessionId,
      target: { pid: TARGET.pid, windowId: String(TARGET.windowId) },
      driver: {
        kind: "module",
        path: join(import.meta.dir, "helpers/observation-budget-driver.ts"),
        export: "createObservationBudgetDriver"
      }
    });
    try {
      const request = driver.call(
        "observe",
        { options: { mode: "image" }, deadlineAt: Date.now() + 1_000 },
        controller.signal
      );
      await delayed.started;
      controller.abort();
      delayed.release();

      const error = await request.then(() => null, (value: unknown) => value);
      expect(error).toBeInstanceOf(ComputerError);
      expect((error as ComputerError).code).toBe("aborted");
    } finally {
      await driver.close();
      clearObservationBudgetDriver(sessionId);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("session cancellation interrupts derivation even with a live per-call signal", async () => {
    const sessionController = new AbortController();
    const operationController = new AbortController();
    const dir = await mkdtemp(join(tmpdir(), "cu-observe-budget-session-"));
    let resolveResize!: () => void;
    let resizeStarted!: () => void;
    const started = new Promise<void>((resolve) => (resizeStarted = resolve));
    const pending = new Promise<void>((resolve) => (resolveResize = resolve));
    const screenshotResizer = async (path: string) => {
      resizeStarted();
      await pending;
      return { path: `${path}-scaled.png`, width: 64, height: 40 };
    };
    const session = makeSession({ artifactsDir: dir, signal: sessionController.signal, screenshotResizer });
    const request = session.computer.observe(TARGET, { mode: "image", maxDimension: 64 }, operationController.signal);

    await started;
    sessionController.abort();
    const error = await request.then(() => null, (value: unknown) => value);
    expect(error).toBeInstanceOf(ComputerError);
    expect((error as ComputerError).code).toBe("aborted");
    resolveResize();
    await session.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("deadline expires during derivation before it can publish", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cu-observe-budget-deadline-"));
    let resolveResize!: () => void;
    let resizeStarted!: () => void;
    const started = new Promise<void>((resolve) => (resizeStarted = resolve));
    const pending = new Promise<void>((resolve) => (resolveResize = resolve));
    const screenshotResizer = async (path: string) => {
      resizeStarted();
      await pending;
      return { path: `${path}-scaled.png`, width: 64, height: 40 };
    };
    const session = makeSession({ artifactsDir: dir, screenshotResizer });
    const deadlineAt = Date.now() + 100;
    const request = session.computer.observe(
      TARGET,
      { mode: "image", maxDimension: 64 },
      { deadlineAt }
    );
    const outcome = request.then(() => null, (value: unknown) => value);

    await started;
    const error = await outcome;
    expect(error).toBeInstanceOf(ComputerError);
    expect((error as ComputerError).code).toBe("command_timeout");
    resolveResize();
    await session.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("a delayed derivation is cancelled without becoming an artifact failure", async () => {
    const controller = new AbortController();
    const dir = await mkdtemp(join(tmpdir(), "cu-observe-budget-"));
    let resolveResize!: () => void;
    let resizeStarted!: () => void;
    const started = new Promise<void>((resolve) => (resizeStarted = resolve));
    const pending = new Promise<void>((resolve) => (resolveResize = resolve));
    const screenshotResizer = async (path: string) => {
      resizeStarted();
      await pending;
      return { path: `${path}-scaled.png`, width: 64, height: 40 };
    };
    const session = makeSession({ artifactsDir: dir, screenshotResizer });
    const request = session.computer.observe(TARGET, { mode: "image", maxDimension: 64 }, controller.signal);

    await started;
    controller.abort();
    resolveResize();
    const error = await request.then(() => null, (value: unknown) => value);
    expect(error).toBeInstanceOf(ComputerError);
    expect((error as ComputerError).code).toBe("aborted");
    expect((error as ComputerError).code).not.toBe("artifact_derivation_failed");
    await session.close();
    await rm(dir, { recursive: true, force: true });
  });
});
