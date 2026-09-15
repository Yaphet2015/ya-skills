import { describe, expect, test } from "bun:test";
import { mapImagePoint, mapImagePointToDriverPixels } from "../packages/computer-runtime/src/coordinates.js";
import type { ImageGeometry } from "../packages/computer-runtime/src/types.js";

const g: ImageGeometry = {
  sourceWidth: 2880,
  sourceHeight: 1800,
  sentWidth: 1440,
  sentHeight: 900,
  inputBounds: { x: 0, y: 0, width: 1440, height: 900 },
  windowBounds: { x: 80, y: 40, width: 1440, height: 900 }
};

describe("mapImagePoint (sent pixels -> window-local points)", () => {
  test("the plan's reference case: input units are POINTS, not a blind x2", () => {
    expect(mapImagePoint({ x: 500, y: 300 }, g)).toEqual({ x: 500, y: 300 });
  });

  test("unscaled 2x Retina capture maps sent pixels to half-size points", () => {
    const retina: ImageGeometry = {
      sourceWidth: 960,
      sourceHeight: 704,
      sentWidth: 960,
      sentHeight: 704,
      inputBounds: { x: 0, y: 0, width: 480, height: 352 },
      windowBounds: { x: 300, y: 368, width: 480, height: 352 }
    };
    // A1 probe: checkbox pixel center (188,176) == point center (94,88).
    expect(mapImagePoint({ x: 188, y: 176 }, retina)).toEqual({ x: 94, y: 88 });
  });

  test("non-integer scale factors keep precision without early rounding", () => {
    const odd: ImageGeometry = {
      sourceWidth: 1000,
      sourceHeight: 800,
      sentWidth: 700,
      sentHeight: 560,
      inputBounds: { x: 0, y: 0, width: 1000, height: 800 },
      windowBounds: { x: 0, y: 0, width: 1000, height: 800 }
    };
    const out = mapImagePoint({ x: 70, y: 56 }, odd);
    expect(out.x).toBeCloseTo(100, 10);
    expect(out.y).toBeCloseTo(80, 10);
  });

  test("non-zero inputBounds origin offsets the mapped point", () => {
    const shifted: ImageGeometry = {
      ...g,
      inputBounds: { x: 10, y: 20, width: 1440, height: 900 }
    };
    expect(mapImagePoint({ x: 500, y: 300 }, shifted)).toEqual({ x: 510, y: 320 });
  });

  test.each([
    { x: -1, y: 300 },
    { x: 500, y: -0.5 },
    { x: 1440, y: 300 },
    { x: 500, y: 900 },
    { x: Number.POSITIVE_INFINITY, y: 300 },
    { x: Number.NaN, y: 300 }
  ])("out-of-image and non-finite points are rejected: %j", (point) => {
    expect(() => mapImagePoint(point, g)).toThrow();
  });

  test.each([
    { sourceWidth: 0, sourceHeight: 800 },
    { sourceWidth: -10, sourceHeight: 800 },
    { sourceWidth: Number.NaN, sourceHeight: 800 }
  ])("invalid geometry is rejected: %j", (patch) => {
    expect(() => mapImagePoint({ x: 1, y: 1 }, { ...g, ...patch })).toThrow(/geometry/i);
  });
});

describe("mapImagePointToDriverPixels (window-local points -> driver pixels)", () => {
  test("unscaled capture is the identity on pixel coordinates", () => {
    const retina: ImageGeometry = {
      sourceWidth: 960,
      sourceHeight: 704,
      sentWidth: 960,
      sentHeight: 704,
      inputBounds: { x: 0, y: 0, width: 480, height: 352 },
      windowBounds: { x: 300, y: 368, width: 480, height: 352 }
    };
    expect(mapImagePointToDriverPixels({ x: 188, y: 176 }, retina)).toEqual({ x: 188, y: 176 });
  });

  test("scaled sent image upscales back to source pixels", () => {
    const scaled: ImageGeometry = {
      ...g,
      sentWidth: 720,
      sentHeight: 450
    };
    // sent center (360,225) -> window point (720,450) -> driver px (1440,900),
    // comfortably inside the 2880x1800 source frame.
    expect(mapImagePointToDriverPixels({ x: 360, y: 225 }, scaled)).toEqual({ x: 1440, y: 900 });
  });

  test("the far corner of the sent image maps inside the source frame or refuses", () => {
    expect(mapImagePointToDriverPixels({ x: 1439.4, y: 899.4 }, g)).not.toBeNull();
    // rounding 1439.9*2 hits exactly 2880 == sourceWidth: refused (outside)
    expect(mapImagePointToDriverPixels({ x: 1439.9, y: 899.9 }, g)).toBeNull();
    expect(mapImagePointToDriverPixels({ x: 1440, y: 900 }, g)).toBeNull();
  });
});
