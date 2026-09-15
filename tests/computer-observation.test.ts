import { describe, expect, test } from "bun:test";
import {
  makeNativeObservation,
  fakeBackendFactory,
  FIXTURE_TARGET
} from "./helpers/computer-fixtures.js";
import type { NativeObservationLike } from "../packages/computer-runtime/src/types.js";
import { projectObservation } from "../packages/computer-runtime/src/observe.js";
import { createSessionWithBackend, ComputerError } from "../packages/computer-runtime/src/session.js";
import type { Backend } from "../packages/computer-runtime/src/types.js";

// ---------------------------------------------------------------------------
// projectObservation — independent channel validity

describe("projectObservation (channel projection)", () => {
  test("degraded AX does not degrade the image channel", () => {
    const raw = makeNativeObservation({ degraded: true, degradedReason: "ax_partial" });
    const view = projectObservation(raw, { mode: "both" });
    expect(view.ax.status).toBe("degraded");
    expect(view.ax.reason).toBe("ax_partial");
    expect(view.image.status).toBe("usable");
    expect(view.ax.complete).toBe(false);
  });

  test("elementsComplete !== true is never reported complete", () => {
    const raw = makeNativeObservation({ elementsComplete: undefined, totalElementCount: 900n, returnedElementCount: 100n });
    const view = projectObservation(raw, { mode: "ax" });
    expect(view.ax.complete).toBe(false);
    expect(view.ax.total).toBe(900);
    expect(view.ax.returned).toBe(100);
  });

  test("missing screenshot data with includeScreenshot semantics is not usable", () => {
    const raw = makeNativeObservation({ images: [], screenshotWidth: undefined, screenshotHeight: undefined });
    const view = projectObservation(raw, { mode: "image" });
    expect(view.image.status).toBe("empty");
  });

  test("frameValid=false demotes the image to degraded", () => {
    const raw = makeNativeObservation({ screenshotFrameValid: false });
    const view = projectObservation(raw, { mode: "both" });
    expect(view.image.status).toBe("degraded");
    expect(view.image.frameValid).toBe(false);
  });

  test("geometry is only present when the screenshot channel is usable", () => {
    const raw = makeNativeObservation();
    const view = projectObservation(raw, { mode: "both" });
    // inputBounds is window-LOCAL points (origin 0,0); windowBounds stays
    // screen-global for change detection (A1 probe evidence).
    expect(view.image.geometry).toEqual({
      sourceWidth: 1280,
      sourceHeight: 800,
      sentWidth: 1280,
      sentHeight: 800,
      inputBounds: { x: 0, y: 0, width: 640, height: 400 },
      windowBounds: { x: 80, y: 40, width: 640, height: 400 }
    });
  });

  test("selector filtering preserves total/returned and reports incompleteness", () => {
    const raw = makeNativeObservation({
      elements: [
        { elementIndex: 0n, role: "AXButton", label: "Save", depth: 1, elementToken: "t1" },
        { elementIndex: 1n, role: "AXButton", label: "Cancel", depth: 1, elementToken: "t2" }
      ],
      totalElementCount: 2n,
      returnedElementCount: 2n
    });
    const view = projectObservation(raw, { mode: "ax", selector: { text: "Save", match: "exact" } });
    expect(view.ax.elements).toHaveLength(1);
    expect(view.ax.elements[0]!.label).toBe("Save");
    expect(view.ax.total).toBe(2);
    expect(view.ax.returned).toBe(1);
    // a filtered view is not a complete view of the window
    expect(view.ax.complete).toBe(false);
  });

  test("zero selector matches does not mean the window is empty", () => {
    const raw = makeNativeObservation();
    const view = projectObservation(raw, { mode: "ax", selector: { text: "Nope", match: "exact" } });
    expect(view.ax.elements).toHaveLength(0);
    expect(view.ax.total).toBe(2);
    expect(view.ax.status).toBe("usable");
  });

  test("truncated AX is reported as truncated with reason", () => {
    const raw = makeNativeObservation({ truncated: true, truncationReason: "max_elements" });
    const view = projectObservation(raw, { mode: "ax" });
    expect(view.ax.status).toBe("truncated");
    expect(view.ax.reason).toBe("max_elements");
  });
});

// ---------------------------------------------------------------------------
// Computer.observe — mode-driven read paths over a fake backend

function observeRecordingBackend(rawFactory: () => NativeObservationLike): {
  backend: Partial<Backend>;
  reads: { ax: number; shot: number };
} {
  const reads = { ax: 0, shot: 0 };
  return {
    reads,
    backend: {
      observe: async (_target, options) => {
        if (options.accessibility) reads.ax++;
        if (options.screenshot) reads.shot++;
        const raw = rawFactory();
        return {
          ...raw,
          elements: options.accessibility ? raw.elements : [],
          totalElementCount: options.accessibility ? raw.totalElementCount : undefined,
          images: options.screenshot ? raw.images : []
        };
      }
    }
  };
}

describe("Computer.observe (mode control)", () => {
  test("ax mode never requests a screenshot", async () => {
    const rec = observeRecordingBackend(() => makeNativeObservation());
    const session = createSessionWithBackend({ load: async () => ({}), create: fakeBackendFactory(rec.backend) });
    const view = await session.computer.observe(FIXTURE_TARGET, { mode: "ax" });
    expect(view.ax.status).toBe("usable");
    expect(view.image.status).toBe("unavailable");
    expect(rec.reads.shot).toBe(0);
    await session.close();
  });

  test("auto mode with usable AX does not request a screenshot", async () => {
    const rec = observeRecordingBackend(() => makeNativeObservation());
    const session = createSessionWithBackend({ load: async () => ({}), create: fakeBackendFactory(rec.backend) });
    const view = await session.computer.observe(FIXTURE_TARGET, { mode: "auto" });
    expect(view.ax.status).toBe("usable");
    expect(rec.reads.shot).toBe(0);
    expect(rec.reads.ax).toBe(1);
    await session.close();
  });

  test("auto mode with insufficient AX takes a second frame with the screenshot", async () => {
    const rec = observeRecordingBackend(() => makeNativeObservation({ degraded: true, degradedReason: "ax_partial" }));
    const session = createSessionWithBackend({ load: async () => ({}), create: fakeBackendFactory(rec.backend) });
    const view = await session.computer.observe(FIXTURE_TARGET, { mode: "auto" });
    expect(view.image.status).toBe("usable");
    expect(view.ax.status).toBe("degraded");
    expect(rec.reads.shot).toBe(1);
    expect(rec.reads.ax).toBe(2);
    await session.close();
  });

  test("image mode ignores AX failures entirely", async () => {
    const backend = fakeBackendFactory({
      observe: async (_t, options) => {
        if (!options.screenshot) throw new ComputerError("degraded_snapshot", "ax down");
        return makeNativeObservation() as never;
      }
    });
    const session = createSessionWithBackend({ load: async () => ({}), create: backend });
    const view = await session.computer.observe(FIXTURE_TARGET, { mode: "image" });
    expect(view.image.status).toBe("usable");
    expect(view.ax.status).toBe("unavailable");
    await session.close();
  });

  test("permission errors still throw in every mode", async () => {
    for (const mode of ["auto", "ax", "image", "both"] as const) {
      const backend = fakeBackendFactory({
        observe: async () => {
          throw new Error("not authorized to send accessibility events");
        }
      });
      const session = createSessionWithBackend({ load: async () => ({}), create: backend });
      await expect(session.computer.observe(FIXTURE_TARGET, { mode })).rejects.toThrow(/not authorized/);
      await session.close();
    }
  });

  test("observations carry identity metadata and are persisted for later clicks", async () => {
    const rec = observeRecordingBackend(() => makeNativeObservation());
    const session = createSessionWithBackend({ load: async () => ({}), create: fakeBackendFactory(rec.backend) });
    const view = await session.computer.observe(FIXTURE_TARGET, { mode: "both" });
    expect(view.id).toBeTruthy();
    expect(view.target).toEqual({ pid: FIXTURE_TARGET.pid, windowId: FIXTURE_TARGET.windowId });
    expect(view.epoch).toBeTruthy();
    expect(view.revision).toBe(0);
    expect(view.capturedAt).toBeGreaterThan(0);
    await session.close();
  });
});
