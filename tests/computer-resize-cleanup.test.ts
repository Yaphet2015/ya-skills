import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ComputerError,
  createSessionWithBackend,
  resizeScreenshot,
  type Backend,
  type NativeObservationLike
} from "../packages/computer-runtime/src/index.js";
import { SYNTHETIC_PNG_BASE64 } from "./helpers/computer-fixtures.js";

const TARGET = { pid: 42_424, windowId: 12_345n };

type Child = ReturnType<typeof Bun.spawn>;

function isAlive(child: Child): boolean {
  try {
    process.kill(child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function installTermResistantSips(): { children: Child[]; restore(): void } {
  const originalSpawn = Bun.spawn;
  const children: Child[] = [];
  (Bun as any).spawn = (command: string[], options: any) => {
    if (command[0] !== "/usr/bin/sips") return originalSpawn(command, options);
    const child = originalSpawn(
      [
        process.execPath,
        "-e",
        'process.on("SIGTERM", () => {}); process.stdout.write("pixelWidth: 2880\\npixelHeight: 1800\\n"); setInterval(() => {}, 1000);'
      ],
      options
    );
    children.push(child);
    return child;
  };
  return {
    children,
    restore() {
      (Bun as any).spawn = originalSpawn;
    }
  };
}

async function stopChildren(children: Child[]): Promise<void> {
  for (const child of children) {
    if (isAlive(child)) child.kill("SIGKILL");
    await child.exited.catch(() => undefined);
  }
}

function observingBackend(): Backend {
  const raw: NativeObservationLike = {
    pid: TARGET.pid,
    windowId: TARGET.windowId,
    elements: [],
    elementsComplete: true,
    screenshotWidth: 1280,
    screenshotHeight: 800,
    screenshotFrameValid: true,
    windowBounds: { x: 0, y: 0, width: 640, height: 400 },
    images: [{ mimeType: "image/png", dataBase64: SYNTHETIC_PNG_BASE64 }],
    observationId: "raw",
    capturedAt: 0,
    epoch: "raw",
    revision: 0
  };
  return {
    apps: async () => [],
    windows: async () => [],
    snapshot: async () => ({ elements: [], title: "" }),
    observe: async () => raw,
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

describe("resize subprocess cleanup", () => {
  test("deadline kills a child that ignores SIGTERM and waits for exit", async () => {
    const harness = installTermResistantSips();
    try {
      const result = await resizeScreenshot(
        "/tmp/review-placeholder.png",
        64,
        undefined,
        undefined,
        Date.now() + 200
      ).then(() => null, (error: unknown) => error);

      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toMatch(/deadline|timed out/i);
      expect(harness.children).toHaveLength(1);
      expect(isAlive(harness.children[0]!)).toBe(false);
    } finally {
      harness.restore();
      await stopChildren(harness.children);
    }
  }, 5_000);

  test("abort kills the child before resize rejects", async () => {
    const harness = installTermResistantSips();
    const controller = new AbortController();
    try {
      const started = Date.now();
      const request = resizeScreenshot(
        "/tmp/review-placeholder.png",
        64,
        controller.signal,
        undefined,
        Date.now() + 200
      );
      setTimeout(() => controller.abort(), 15);
      const result = await request.then(() => null, (error: unknown) => error);

      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toMatch(/aborted|cancel/i);
      expect(Date.now() - started).toBeLessThan(180);
      expect(harness.children).toHaveLength(1);
      expect(isAlive(harness.children[0]!)).toBe(false);
    } finally {
      harness.restore();
      await stopChildren(harness.children);
    }
  }, 5_000);

  test("session close waits for a timed-out derived screenshot to exit", async () => {
    const harness = installTermResistantSips();
    const artifactsDir = await mkdtemp(join(tmpdir(), "cu-resize-cleanup-"));
    const session = createSessionWithBackend(
      { load: async () => ({}), create: async () => observingBackend() },
      { artifactsDir, cleanupDeadlineMs: 1_000 }
    );
    try {
      const error = await session.computer.observe(
        TARGET,
        { mode: "image", maxDimension: 64 },
        { deadlineAt: Date.now() + 200 }
      ).then(() => null, (value: unknown) => value);

      expect(error).toBeInstanceOf(ComputerError);
      expect((error as ComputerError).code).toBe("command_timeout");
      await session.close();
      expect(harness.children).toHaveLength(1);
      expect(isAlive(harness.children[0]!)).toBe(false);
    } finally {
      await session.close().catch(() => undefined);
      harness.restore();
      await stopChildren(harness.children);
      await rm(artifactsDir, { recursive: true, force: true });
    }
  }, 5_000);
});
