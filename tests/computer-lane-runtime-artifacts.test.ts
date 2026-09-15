import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createSessionWithBackend } from "../packages/computer-runtime/src/session.js";
import { createObservationStore, resizeScreenshot, type ProcessRunner } from "../packages/computer-runtime/src/observation-store.js";
import { ensurePrivateFile, saveScreenshot } from "../packages/computer-runtime/src/artifacts.js";
import type { Backend, Observation, Target } from "../packages/computer-runtime/src/types.js";
import { makeNativeObservation, syntheticPngBuffer, SYNTHETIC_PNG_BASE64 } from "./helpers/computer-fixtures.js";

const TARGET: Target = { pid: 4242, windowId: 12345n };

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

function noOpBackend(overrides: Partial<Backend> = {}): Backend {
  return {
    apps: async () => [],
    windows: async () => [],
    snapshot: async () => ({ elements: [], title: "" }),
    observe: async () => makeNativeObservation(),
    clickToken: async () => ({ isError: false }),
    clickPoint: async () => ({ isError: false }),
    type: async () => ({ isError: false }),
    key: async () => ({ isError: false }),
    scroll: async () => ({ isError: false }),
    metadata: async () => ({ driverVersion: "lane", pid: process.pid }),
    permissions: async () => ({ accessibility: true, screenRecording: true }),
    endSession: async () => undefined,
    shutdown: async () => undefined,
    destroy: () => undefined,
    ...overrides
  };
}

describe("runtime lane screenshot privacy", () => {
  test("saveScreenshot enforces 0600 on the created artifact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cu-lane-artifact-"));
    try {
      const path = saveScreenshot(dir, SYNTHETIC_PNG_BASE64);
      expect(await modeOf(path)).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("existing permissive observation images are repaired before store use", async () => {
    const root = await mkdtemp(join(tmpdir(), "cu-lane-store-"));
    const imageDir = await mkdtemp(join(tmpdir(), "cu-lane-image-"));
    const image = join(imageDir, "capture.png");
    try {
      await writeFile(image, syntheticPngBuffer(), { mode: 0o644 });
      const observation: Observation = {
        id: randomUUID(),
        target: TARGET,
        capturedAt: Date.now(),
        epoch: "lane",
        revision: 0,
        title: "fixture",
        ax: { status: "usable", elements: [], total: 0, returned: 0, complete: true },
        image: { status: "usable", originalPath: image, path: image }
      };
      const store = createObservationStore(root);
      await store.save(observation);
      expect(await modeOf(image)).toBe(0o600);
      await chmod(image, 0o644);
      await store.get(observation.id);
      expect(await modeOf(image)).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(imageDir, { recursive: true, force: true });
    }
  });

  test("copied screenshot paths are private even when the source is permissive", async () => {
    const artifacts = await mkdtemp(join(tmpdir(), "cu-lane-copy-"));
    const sourceDir = await mkdtemp(join(tmpdir(), "cu-lane-source-"));
    const source = join(sourceDir, "native.png");
    try {
      await writeFile(source, syntheticPngBuffer(), { mode: 0o644 });
      const raw = { ...makeNativeObservation({ images: [] }), screenshotFilePath: source };
      const session = createSessionWithBackend(
        { load: async () => ({}), create: async () => noOpBackend({ observe: async () => raw }) },
        { artifactsDir: artifacts }
      );
      const observation = await session.computer.observe(TARGET, { mode: "image" });
      expect(observation.image.path).toBeTruthy();
      expect(await modeOf(observation.image.path!)).toBe(0o600);
      expect(await modeOf(source)).toBe(0o644);
      await session.close();
    } finally {
      await rm(artifacts, { recursive: true, force: true });
      await rm(sourceDir, { recursive: true, force: true });
    }
  });

  test("resize repairs an existing permissive source and derived path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cu-lane-resize-"));
    const original = join(dir, "capture.png");
    const derived = join(dir, "capture-64.png");
    try {
      await writeFile(original, syntheticPngBuffer(), { mode: 0o644 });
      await writeFile(derived, syntheticPngBuffer(), { mode: 0o644 });
      const runner: ProcessRunner = async (_command, args) => {
        if (args[0] === "-g" && args.includes(original)) {
          return { stdout: "pixelWidth: 128\npixelHeight: 80\n", stderr: "", code: 0 };
        }
        return { stdout: "pixelWidth: 64\npixelHeight: 40\n", stderr: "", code: 0 };
      };
      const result = await resizeScreenshot(original, 64, undefined, runner);
      expect(result.path).toBe(derived);
      expect(await modeOf(original)).toBe(0o600);
      expect(await modeOf(derived)).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("privacy validation fails loudly for a non-file path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cu-lane-private-"));
    try {
      expect(() => ensurePrivateFile(dir)).toThrow(/not private|regular|screenshot/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
