// Bounded screenshot evidence comparison. PNG parsing is delegated to the
// maintained pngjs decoder; this module owns the click-specific policy:
// normalize decoded pixels, require an unchanged neighbourhood around the
// requested coordinate, and bound unrelated global drift. Decode failures
// always return false so malformed/unsupported evidence cannot authorize input.

import { readFileSync } from "node:fs";
import { PNG } from "pngjs";

interface DecodedPng {
  width: number;
  height: number;
  /** pngjs normalizes supported input formats to RGBA bytes. */
  data: Uint8Array;
}

const PNG_SIGNATURE = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
]);
const MAX_DIMENSION = 32_768;
const MAX_PIXELS = 64 * 1024 * 1024;

// The local target check is expressed in the sent-image coordinate space and
// mapped to source pixels, so Retina/source scaling keeps the same visual
// neighbourhood.
export const TARGET_NEIGHBOURHOOD_SENT_PIXELS = 32;
export const TARGET_NEIGHBOURHOOD_MIN_RADIUS = 2;

// The global check is deliberately strict. A small cursor/clock blink can be
// tolerated, while a form/page navigation that changes a meaningful region is
// refused. The absolute cap prevents the ratio from becoming permissive on a
// huge screenshot.
export const MAX_GLOBAL_PIXEL_CHANGE_RATIO = 0.001;
export const MAX_GLOBAL_CHANGED_PIXELS = 1024;

export interface EvidencePoint {
  x: number;
  y: number;
}

export interface EvidenceGeometry {
  sentWidth: number;
  sentHeight: number;
  sourceWidth: number;
  sourceHeight: number;
}

function readU32(data: Uint8Array, offset: number): number {
  return (
    (data[offset]! * 0x1000000) +
    (data[offset + 1]! << 16) +
    (data[offset + 2]! << 8) +
    data[offset + 3]!
  ) >>> 0;
}

/** Inspect IHDR before invoking pngjs. This keeps decompression/allocation
 * bounded even if a malformed artifact advertises a huge image. */
function assertHeaderBounded(data: Uint8Array): void {
  if (data.length < 33) throw new Error("PNG is truncated");
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (data[i] !== PNG_SIGNATURE[i]) throw new Error("PNG signature is invalid");
  }
  if (readU32(data, 8) !== 13 || data[12] !== 0x49 || data[13] !== 0x48 || data[14] !== 0x44 || data[15] !== 0x52) {
    throw new Error("PNG does not start with IHDR");
  }
  const width = readU32(data, 16);
  const height = readU32(data, 20);
  if (width <= 0 || height <= 0 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new Error("PNG dimensions are out of bounds");
  }
  if (width > Math.floor(MAX_PIXELS / height)) throw new Error("PNG has too many pixels");
}

function decode(path: string, expected?: { width: number; height: number }): DecodedPng {
  const bytes = readFileSync(path);
  assertHeaderBounded(bytes);
  const decoded = PNG.sync.read(bytes, { checkCRC: true });
  if (
    !Number.isSafeInteger(decoded.width) || decoded.width <= 0 ||
    !Number.isSafeInteger(decoded.height) || decoded.height <= 0 ||
    !(decoded.data instanceof Uint8Array) || decoded.data.length !== decoded.width * decoded.height * 4
  ) {
    throw new Error("decoded PNG has invalid RGBA dimensions");
  }
  if (expected !== undefined && (decoded.width !== expected.width || decoded.height !== expected.height)) {
    throw new Error("PNG dimensions do not match screenshot geometry");
  }
  return decoded;
}

function pixelOffset(image: DecodedPng, x: number, y: number): number {
  return (y * image.width + x) * 4;
}

function pixelDiffers(reference: DecodedPng, current: DecodedPng, x: number, y: number): boolean {
  const a = pixelOffset(reference, x, y);
  const b = pixelOffset(current, x, y);
  return (
    reference.data[a] !== current.data[b] ||
    reference.data[a + 1] !== current.data[b + 1] ||
    reference.data[a + 2] !== current.data[b + 2] ||
    reference.data[a + 3] !== current.data[b + 3]
  );
}

/** Compare two PNG artifacts using a click-local stability check and a strict
 * whole-frame change bound. This proves bounded visual stability only; it does
 * not claim that pixels alone identify the semantic UI control. */
export function matchesBoundedPngEvidence(
  referencePath: string,
  currentPath: string,
  point: EvidencePoint,
  geometry: EvidenceGeometry
): boolean {
  try {
    if (
      !Number.isFinite(point.x) || !Number.isFinite(point.y) ||
      !Number.isFinite(geometry.sentWidth) || !Number.isFinite(geometry.sentHeight) ||
      !Number.isFinite(geometry.sourceWidth) || !Number.isFinite(geometry.sourceHeight) ||
      geometry.sentWidth <= 0 || geometry.sentHeight <= 0 ||
      geometry.sourceWidth <= 0 || geometry.sourceHeight <= 0 ||
      point.x < 0 || point.y < 0 || point.x >= geometry.sentWidth || point.y >= geometry.sentHeight
    ) return false;
    const reference = decode(referencePath, { width: geometry.sourceWidth, height: geometry.sourceHeight });
    const current = decode(currentPath, { width: geometry.sourceWidth, height: geometry.sourceHeight });
    if (reference.width !== current.width || reference.height !== current.height) return false;

    // Map the model-visible sent-image coordinate into decoded pixel space.
    const targetX = Math.min(reference.width - 1, Math.max(0, Math.floor((point.x / geometry.sentWidth) * reference.width)));
    const targetY = Math.min(reference.height - 1, Math.max(0, Math.floor((point.y / geometry.sentHeight) * reference.height)));
    const radiusX = Math.max(
      TARGET_NEIGHBOURHOOD_MIN_RADIUS,
      Math.ceil(TARGET_NEIGHBOURHOOD_SENT_PIXELS * reference.width / geometry.sentWidth)
    );
    const radiusY = Math.max(
      TARGET_NEIGHBOURHOOD_MIN_RADIUS,
      Math.ceil(TARGET_NEIGHBOURHOOD_SENT_PIXELS * reference.height / geometry.sentHeight)
    );
    const minX = Math.max(0, targetX - radiusX);
    const maxX = Math.min(reference.width - 1, targetX + radiusX);
    const minY = Math.max(0, targetY - radiusY);
    const maxY = Math.min(reference.height - 1, targetY + radiusY);

    // The click neighbourhood is the strongest local guard. Any local pixel
    // change causes a fresh observation request instead of a blind click.
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        if (pixelDiffers(reference, current, x, y)) return false;
      }
    }

    const totalPixels = reference.width * reference.height;
    const ratioLimit = Math.floor(totalPixels * MAX_GLOBAL_PIXEL_CHANGE_RATIO);
    const maxChanged = Math.min(MAX_GLOBAL_CHANGED_PIXELS, ratioLimit);
    let changed = 0;
    for (let y = 0; y < reference.height; y += 1) {
      for (let x = 0; x < reference.width; x += 1) {
        if (pixelDiffers(reference, current, x, y)) {
          changed += 1;
          if (changed > maxChanged) return false;
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Validate a screenshot artifact without exposing decoder errors to the
 * evidence path. This keeps the exact-hash fast path fail-closed too. */
export function isSupportedPng(path: string, expected?: { width: number; height: number }): boolean {
  try {
    decode(path, expected);
    return true;
  } catch {
    return false;
  }
}
