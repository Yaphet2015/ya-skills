import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComputerUseCommands } from "../packages/functions-computer-use/src/commands.js";
import {
  createObservationStore,
  createSessionWithBackend,
  type Backend,
  type ComputerSession
} from "@ya-skills/computer-runtime";
import {
  fakeBackendFactory,
  FIXTURE_TARGET,
  makeNativeObservation
} from "./helpers/computer-fixtures.js";

function makeSession(
  artifactsDir: string,
  clickPoints: Array<{ x: number; y: number }>
): ComputerSession {
  const backend: Partial<Backend> = {
    windows: async () => [{ ...FIXTURE_TARGET, title: "Fixture" }],
    observe: async () => makeNativeObservation(),
    snapshot: async () => ({ elements: [], title: "Fixture" }),
    clickPoint: async (_target, point) => {
      clickPoints.push(point);
      return { isError: false };
    }
  };
  return createSessionWithBackend(
    { load: async () => ({}), create: fakeBackendFactory(backend) },
    {
      artifactsDir,
      observationStore: createObservationStore(join(artifactsDir, "observations"))
    }
  );
}

describe("computer-use one-shot observation artifacts", () => {
  test("act reads an observation saved by observe in the same --out-dir", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "yk-computer-use-out-dir-"));
    const clickPoints: Array<{ x: number; y: number }> = [];
    try {
      const commands = createComputerUseCommands({
        createSession: ({ artifactsDir } = {}) =>
          makeSession(artifactsDir ?? join(outDir, "default-artifacts"), clickPoints)
      });
      const observe = commands.find((command) => command.action === "observe")!;
      const act = commands.find((command) => command.action === "act")!;
      const observed = JSON.parse(
        (await observe.run([
          "--pid", String(FIXTURE_TARGET.pid),
          "--window", FIXTURE_TARGET.windowId.toString(),
          "--mode", "both",
          "--out-dir", outDir
        ])) as string
      ) as { observation: { id: string } };

      expect(observed.observation.id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(existsSync(join(outDir, "observations", `${observed.observation.id}.json`))).toBe(true);

      await act.run([
        "--pid", String(FIXTURE_TARGET.pid),
        "--window", FIXTURE_TARGET.windowId.toString(),
        "--click-x", "640",
        "--click-y", "400",
        "--observation", observed.observation.id,
        "--out-dir", outDir
      ]);

      expect(clickPoints).toEqual([{ x: 640, y: 400 }]);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
