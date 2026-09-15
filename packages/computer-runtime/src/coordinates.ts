// Pure coordinate mapping between observation image pixels, window-local
// input points, and driver pixel inputs. Units verified by the A1 desktop
// probe (docs/verification/2026-09-14-computer-use-agentic-primitives.md §4.5):
//   - screenshot pixels = window points x screenshotScale (Retina 2x here)
//   - ClickPosition.Coordinates expects window-local PIXELS, top-left origin
//   - windowBounds / element frames are screen-global POINTS

import type { ImageGeometry, Point } from "./types.js";

function finiteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

function assertGeometry(geometry: ImageGeometry): void {
  const { sourceWidth, sourceHeight, sentWidth, sentHeight, inputBounds } = geometry;
  if (
    !finiteNumber(sourceWidth) || sourceWidth <= 0 ||
    !finiteNumber(sourceHeight) || sourceHeight <= 0 ||
    !finiteNumber(sentWidth) || sentWidth <= 0 ||
    !finiteNumber(sentHeight) || sentHeight <= 0 ||
    !finiteNumber(inputBounds.x) || !finiteNumber(inputBounds.y) ||
    !finiteNumber(inputBounds.width) || inputBounds.width <= 0 ||
    !finiteNumber(inputBounds.height) || inputBounds.height <= 0
  ) {
    throw new Error(`invalid image geometry: ${JSON.stringify(geometry)}`);
  }
}

/** Map a point on the SENT image (the pixels an external model saw) to
 * window-local input POINTS. No rounding: precision survives to the adapter. */
export function mapImagePoint(point: Point, geometry: ImageGeometry): Point {
  assertGeometry(geometry);
  if (!finiteNumber(point.x) || !finiteNumber(point.y)) {
    throw new Error(`point coordinates must be finite numbers (got: ${JSON.stringify(point)})`);
  }
  if (point.x < 0 || point.y < 0 || point.x >= geometry.sentWidth || point.y >= geometry.sentHeight) {
    throw new Error(
      `point (${point.x}, ${point.y}) is outside the sent image (${geometry.sentWidth}x${geometry.sentHeight})`
    );
  }
  return {
    x: geometry.inputBounds.x + (point.x * geometry.inputBounds.width) / geometry.sentWidth,
    y: geometry.inputBounds.y + (point.y * geometry.inputBounds.height) / geometry.sentHeight
  };
}

/** Map a sent-image pixel point all the way to the driver's expected
 * window-local PIXEL input (what ClickPosition.Coordinates takes). Returns
 * null when the point cannot be represented inside the source frame. */
export function mapImagePointToDriverPixels(point: Point, geometry: ImageGeometry): Point | null {
  try {
    const local = mapImagePoint(point, geometry);
    const scaleX = geometry.sourceWidth / geometry.inputBounds.width;
    const scaleY = geometry.sourceHeight / geometry.inputBounds.height;
    if (!finiteNumber(scaleX) || !finiteNumber(scaleY) || scaleX <= 0 || scaleY <= 0) return null;
    const px = {
      x: Math.round(local.x * scaleX),
      y: Math.round(local.y * scaleY)
    };
    if (px.x < 0 || px.y < 0 || px.x >= geometry.sourceWidth || px.y >= geometry.sourceHeight) {
      return null;
    }
    return px;
  } catch {
    return null;
  }
}
