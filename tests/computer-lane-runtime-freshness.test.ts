import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionWithBackend } from "../packages/computer-runtime/src/session.js";
import { createObservationStore } from "../packages/computer-runtime/src/observation-store.js";
import { makeNativeObservation, FIXTURE_TARGET } from "./helpers/computer-fixtures.js";
import type { Backend } from "../packages/computer-runtime/src/types.js";

function backend(overrides: Partial<Backend> = {}): Backend {
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

describe("runtime lane same-epoch freshness", () => {
  test("a naturally observed observation can click after same-epoch fresh-frame validation", async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), "cu-lane-fresh-store-"));
    const artifacts = await mkdtemp(join(tmpdir(), "cu-lane-fresh-artifacts-"));
    const calls: string[] = [];
    let clicks = 0;
    try {
      const raw = makeNativeObservation({ target: FIXTURE_TARGET });
      const session = createSessionWithBackend(
        {
          load: async () => ({}),
          create: async () => backend({
            observe: async () => {
              calls.push("observe");
              // Every frame is produced by this live session with identical
              // target geometry and bytes; no hand-seeded epoch is used.
              return raw;
            },
            clickPoint: async () => {
              calls.push("clickPoint");
              clicks += 1;
              return { isError: false };
            }
          })
        },
        { artifactsDir: artifacts, observationStore: createObservationStore(storeRoot) }
      );
      const observation = await session.computer.observe(FIXTURE_TARGET, { mode: "both" });
      expect(observation.epoch).toBeTruthy();
      await session.computer.clickPoint(FIXTURE_TARGET, {
        observationId: observation.id,
        x: 640,
        y: 400
      });
      expect(calls).toEqual(["observe", "observe", "clickPoint"]);
      expect(clicks).toBe(1);
      await session.close();
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
      await rm(artifacts, { recursive: true, force: true });
    }
  });
});
