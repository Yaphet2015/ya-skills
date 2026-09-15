import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionWithBackend, ComputerError, OBSERVATION_TTL_MS } from "../packages/computer-runtime/src/session.js";
import { createObservationStore } from "../packages/computer-runtime/src/observation-store.js";
import { projectObservation } from "../packages/computer-runtime/src/observe.js";
import type { Observation, Point, Target } from "../packages/computer-runtime/src/types.js";
import { fakeBackendFactory, FIXTURE_TARGET, makeNativeObservation, syntheticPngBuffer } from "./helpers/computer-fixtures.js";
import { writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";

async function makeSession(backend: Partial<ReturnType<typeof fakeBackendFactory> extends never ? never : object> = {}, observationAge = 0) {
  const root = await mkdtemp(join(tmpdir(), "cu-click-"));
  const store = createObservationStore(root);
  const imageDir = await mkdtemp(join(tmpdir(), "cu-click-img-"));
  const imageFile = join(imageDir, "cu.png");
  await writeFile(imageFile, syntheticPngBuffer());
  const backendWithObserve = {
    ...backend,
    observe: backend["observe" as keyof typeof backend] ?? (async () => makeNativeObservation())
  } as Parameters<typeof fakeBackendFactory>[0];
  const session = createSessionWithBackend(
    { load: async () => ({}), create: fakeBackendFactory(backendWithObserve) },
    { observationStore: store }
  );
  // Persist a valid observation to click against.
  const raw = makeNativeObservation();
  const observation: Observation = {
    ...projectObservation(
      { ...raw, observationId: "seed", capturedAt: Date.now() - observationAge, epoch: "", revision: 0 } as never,
      { mode: "both" }
    ),
    id: randomUUID()
  };
  observation.image = { ...observation.image, originalPath: imageFile, path: imageFile };
  observation.capturedAt = Date.now() - observationAge;
  await store.save(observation);
  return { session, store, observation, root, imageDir };
}

const target: Target = FIXTURE_TARGET;

describe("Computer.clickPoint (evidence-bound delivery)", () => {
  test("an expired observation never reaches the driver", async () => {
    const calls: Point[] = [];
    const { session, observation, root, imageDir } = await makeSession(
      {
        clickPoint: async (_t: Target, point: Point) => {
          calls.push(point);
          return { isError: false };
        }
      },
      OBSERVATION_TTL_MS + 5_000
    );
    try {
      await expect(
        session.computer.clickPoint(target, { observationId: observation.id, x: 5, y: 5 })
      ).rejects.toThrow(/stale_observation|older than/);
      expect(calls).toEqual([]);
    } finally {
      await session.close();
      await rm(root, { recursive: true, force: true });
      await rm(imageDir, { recursive: true, force: true });
    }
  });

  test("a valid observation maps through the geometry before delivery", async () => {
    const calls: Point[] = [];
    const { session, observation, root, imageDir } = await makeSession({
      clickPoint: async (_t: Target, point: Point) => {
        calls.push(point);
        return { isError: false };
      }
    });
    try {
      // Fixture geometry: 1280x800 sent image over a 640x400pt window ->
      // sent pixel (640,400) == window-local point (320,200) == driver px
      // (640,400) at scale 2 — identity on the unscaled capture.
      await session.computer.clickPoint(target, { observationId: observation.id, x: 640, y: 400 });
      expect(calls).toEqual([{ x: 640, y: 400 }]);
    } finally {
      await session.close();
      await rm(root, { recursive: true, force: true });
      await rm(imageDir, { recursive: true, force: true });
    }
  });

  test("same-epoch window movement refuses the old frame before delivery", async () => {
    const calls: Point[] = [];
    let reads = 0;
    const { session, observation, root, imageDir } = await makeSession({
      observe: async () => {
        reads++;
        return makeNativeObservation({
          windowBounds: reads > 0 ? { x: 81, y: 40, width: 640, height: 400 } : undefined
        });
      },
      clickPoint: async (_t: Target, point: Point) => {
        calls.push(point);
        return { isError: false };
      }
    });
    try {
      await expect(
        session.computer.clickPoint(target, { observationId: observation.id, x: 10, y: 10 })
      ).rejects.toThrow(/window changed|stale/);
      expect(calls).toEqual([]);
    } finally {
      await session.close();
      await rm(root, { recursive: true, force: true });
      await rm(imageDir, { recursive: true, force: true });
    }
  });

  test("out-of-image coordinates are refused before any driver call", async () => {
    const calls: Point[] = [];
    const { session, observation, root, imageDir } = await makeSession({
      clickPoint: async (_t: Target, point: Point) => {
        calls.push(point);
        return { isError: false };
      }
    });
    try {
      await expect(
        session.computer.clickPoint(target, { observationId: observation.id, x: 5000, y: 5 })
      ).rejects.toThrow(ComputerError);
      expect(calls).toEqual([]);
    } finally {
      await session.close();
      await rm(root, { recursive: true, force: true });
      await rm(imageDir, { recursive: true, force: true });
    }
  });

  test("a background refusal maps to not_delivered; no foreground retry ever", async () => {
    let calls = 0;
    const events: string[] = [];
    const store = createObservationStore(await mkdtemp(join(tmpdir(), "cu-ref-")));
    const imageDir2 = (await mkdir(join(tmpdir(), `cu-ref-img-${Date.now()}`), { recursive: true }))!;
    const imageFile2 = join(imageDir2, "cu.png");
    await writeFile(imageFile2, syntheticPngBuffer());
    const seeded = makeNativeObservation();
    const observation: Observation = {
      ...projectObservation({ ...seeded, observationId: "seed" } as never, { mode: "both" }),
      id: randomUUID(),
      capturedAt: Date.now()
    };
    observation.image = { ...observation.image, originalPath: imageFile2, path: imageFile2 };
    await store.save(observation);
    const session = createSessionWithBackend(
      {
        load: async () => ({}),
        create: fakeBackendFactory({
          observe: async () => makeNativeObservation(),
          clickPoint: async () => {
            calls++;
            const error = new Error("click: outside frame; background delivery refused");
            (error as Error & { name: string }).name = "DriverError.Tool";
            throw error;
          }
        })
      },
      { observationStore: store, onAction: (e) => events.push(`${e.phase}:${e.kind}:${e.outcome ?? ""}`) }
    );
    const refusal = await session.computer
      .clickPoint(target, { observationId: observation.id, x: 640, y: 400 })
      .then(() => null, (e: unknown) => e);
    expect(refusal).toBeInstanceOf(ComputerError);
    expect((refusal as ComputerError).code).toBe("action_refused");
    expect((refusal as ComputerError).actionOutcome).toBe("not_delivered");
    expect(calls).toBe(1); // refused once, never retried in the foreground
    expect(events).toContain("finished:click_point:not_delivered");
    await session.close();
  });

  test("a delivered clickPoint invalidates the observation for the next click", async () => {
    const { session, observation, root, imageDir } = await makeSession({
      clickPoint: async (_t: Target, _p: Point) => ({ isError: false })
    });
    try {
      await session.computer.clickPoint(target, { observationId: observation.id, x: 640, y: 400 });
      await expect(
        session.computer.clickPoint(target, { observationId: observation.id, x: 640, y: 400 })
      ).rejects.toThrow(/invalidated|stale/);
    } finally {
      await session.close();
      await rm(root, { recursive: true, force: true });
      await rm(imageDir, { recursive: true, force: true });
    }
  });

  test("a type mutation between observe and clickPoint refuses the old observation", async () => {
    const { session, observation, root, imageDir } = await makeSession({
      clickPoint: async (_t: Target, _p: Point) => ({ isError: false }),
      type: async () => ({ isError: false })
    });
    try {
      await session.computer.type(target, "x");
      const error = await session.computer
        .clickPoint(target, { observationId: observation.id, x: 640, y: 400 })
        .then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(ComputerError);
      expect(["stale_observation", "unknown_observation"]).toContain((error as ComputerError).code);
      expect((error as ComputerError).message).toMatch(/invalidated|stale|mutation/);
    } finally {
      await session.close();
      await rm(root, { recursive: true, force: true });
      await rm(imageDir, { recursive: true, force: true });
    }
  });

  test("unknown observations and cross-target observations are refused", async () => {
    const { session, root, imageDir } = await makeSession({ clickPoint: async () => ({ isError: false }) });
    try {
      await expect(
        session.computer.clickPoint(target, { observationId: randomUUID(), x: 1, y: 1 })
      ).rejects.toThrow(/unknown_observation|not usable/);
      await expect(
        session.computer.clickPoint({ pid: 1, windowId: 1n }, { observationId: "x", x: 1, y: 1 })
      ).rejects.toThrow();
    } finally {
      await session.close();
      await rm(root, { recursive: true, force: true });
      await rm(imageDir, { recursive: true, force: true });
    }
  });
});

describe("action outcome classification (A4 refinement)", () => {
  test("a known ToolResult refusal is not_delivered; an unknown native exception is unknown", async () => {
    const outcomes: (string | undefined)[] = [];
    // Known refusal: ToolResult.isError
    const s1 = createSessionWithBackend(
      {
        load: async () => ({}),
        create: fakeBackendFactory({
          type: async () => ({ isError: true, text: "refused" })
        })
      },
      { onAction: (e) => outcomes.push(`refusal:${e.outcome}`) }
    );
    const err1 = await s1.computer.type(target, "a").then(() => null, (e: unknown) => e);
    expect((err1 as ComputerError).code).toBe("action_refused");
    await s1.close();
    // Unknown native exception: thrown object with no classification.
    const s2 = createSessionWithBackend(
      {
        load: async () => ({}),
        create: fakeBackendFactory({
          type: async () => {
            throw new Error("DriverError.Unexpected: native crash mid-call");
          }
        })
      },
      { onAction: (e) => outcomes.push(`native:${e.outcome}`) }
    );
    await expect(s2.computer.type(target, "a")).rejects.toThrow(/DriverError/);
    await s2.close();
    expect(outcomes).toContain("refusal:not_delivered");
    expect(outcomes).toContain("native:unknown");
  });
});
