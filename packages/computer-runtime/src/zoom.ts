// Derive a view from existing evidence. No driver reads and no new credentials.
import { unlinkSync } from "node:fs";
import { artifactPath, ensureOutDir } from "./artifacts.js";
import { ComputerError } from "./driver-result.js";
import { readPngDimensions } from "./image-evidence.js";
import type { ObservationStore } from "./observation-store.js";
import { OBSERVATION_TTL_MS, OP_LIMIT_MS } from "./session.js";
import {
  assertResizeAllowed,
  cropScreenshot,
  DEFAULT_MAX_DIMENSION,
  DEFAULT_MAX_PIXELS,
  discardScreenshot,
  ProcessCleanupError,
  resizeScreenshot,
  validateImageBudget,
  type ImageBudget,
  type ProcessRunner
} from "./screenshot.js";
import type { Observation, Point, Rect } from "./types.js";

export interface ZoomResult {
  observationId: string;
  capturedAt: number;
  image: { path: string; width: number; height: number };
  /** Actual crop coverage in the parent observation's sent-image pixels. */
  region: Rect;
  coordinateSpace: "parent-observation";
}

export interface ZoomOptions extends ImageBudget {
  outDir?: string;
  signal?: AbortSignal;
  deadlineAt?: number;
  /** Internal transform seam; does not read the desktop. */
  runner?: ProcessRunner;
}

function assertFresh(observation: Observation): void {
  const age = Date.now() - observation.capturedAt;
  if (!Number.isFinite(age) || age > OBSERVATION_TTL_MS || age < 0) {
    throw new ComputerError("stale_observation", "the parent observation expired; take a fresh observation");
  }
}

async function loadParent(store: ObservationStore, id: string): Promise<Observation> {
  let observation: Observation;
  try {
    observation = await store.get(id);
  } catch (error) {
    throw new ComputerError("observation_unavailable", `the parent observation is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertFresh(observation);
  return observation;
}

function validateRegion(region: Rect, width: number, height: number): void {
  if (![region.x, region.y, region.width, region.height, width, height].every(Number.isFinite) ||
      width <= 0 || height <= 0 || region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0 ||
      region.x + region.width > width || region.y + region.height > height) {
    throw new ComputerError("invalid_request", "zoom region must be positive and within the parent image bounds");
  }
}

export function mapZoomPointToParent(zoom: ZoomResult, point: Point): Point {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) ||
      point.x < 0 || point.y < 0 || point.x >= zoom.image.width || point.y >= zoom.image.height) {
    throw new ComputerError("invalid_request", "zoom point is outside image bounds");
  }
  return {
    x: zoom.region.x + point.x * zoom.region.width / zoom.image.width,
    y: zoom.region.y + point.y * zoom.region.height / zoom.image.height
  };
}

export async function zoomObservation(
  store: ObservationStore,
  observationId: string,
  region: Rect,
  options: ZoomOptions = {}
): Promise<ZoomResult> {
  try {
    validateImageBudget(options);
  } catch (error) {
    throw new ComputerError("invalid_request", (error as Error).message);
  }
  const controls = { signal: options.signal, deadlineAt: options.deadlineAt ?? Date.now() + OP_LIMIT_MS };
  const artifacts: string[] = [];
  try {
    assertResizeAllowed(controls);
    const parent = await loadParent(store, observationId);
    const geometry = parent.image.geometry;
    const original = parent.image.originalPath;
    if (!geometry || !original) {
      throw new ComputerError("observation_unavailable", "the parent has no source image geometry");
    }
    validateRegion(region, geometry.sentWidth, geometry.sentHeight);
    readPngDimensions(original, { width: geometry.sourceWidth, height: geometry.sourceHeight });
    // Cover the requested region with whole source pixels, then report that
    // effective coverage. Mapping with the requested fractional region drifts.
    const x = Math.floor(region.x * geometry.sourceWidth / geometry.sentWidth);
    const y = Math.floor(region.y * geometry.sourceHeight / geometry.sentHeight);
    const right = Math.min(geometry.sourceWidth, Math.ceil((region.x + region.width) * geometry.sourceWidth / geometry.sentWidth));
    const bottom = Math.min(geometry.sourceHeight, Math.ceil((region.y + region.height) * geometry.sourceHeight / geometry.sentHeight));
    const sourceRegion = { x, y, width: right - x, height: bottom - y };
    validateRegion(sourceRegion, geometry.sourceWidth, geometry.sourceHeight);
    const cropPath = artifactPath(ensureOutDir(options.outDir), "zoom.png");
    artifacts.push(cropPath);
    await cropScreenshot(original, cropPath, sourceRegion, controls, options.runner);
    const image = await resizeScreenshot(
      cropPath,
      options.maxDimension ?? DEFAULT_MAX_DIMENSION,
      controls.signal,
      options.runner,
      controls.deadlineAt,
      options.maxPixels ?? DEFAULT_MAX_PIXELS,
      sourceRegion
    );
    if (image.path !== cropPath) artifacts.push(image.path);
    // The observation may expire or be invalidated while the transform runs.
    // Reading it again does not refresh its TTL or create a click credential.
    await loadParent(store, observationId);
    assertResizeAllowed(controls);
    if (image.path !== cropPath) unlinkSync(cropPath);
    return {
      observationId: parent.id,
      capturedAt: parent.capturedAt,
      image,
      region: {
        x: x * geometry.sentWidth / geometry.sourceWidth,
        y: y * geometry.sentHeight / geometry.sourceHeight,
        width: sourceRegion.width * geometry.sentWidth / geometry.sourceWidth,
        height: sourceRegion.height * geometry.sentHeight / geometry.sourceHeight
      },
      coordinateSpace: "parent-observation"
    };
  } catch (error) {
    for (const path of artifacts) discardScreenshot(path);
    if (error instanceof ComputerError) throw error;
    if (error instanceof ProcessCleanupError) throw new ComputerError("cleanup_failed", error.message);
    if (controls.signal?.aborted) throw new ComputerError("aborted", "zoom was aborted");
    if (Date.now() >= controls.deadlineAt) throw new ComputerError("command_timeout", "zoom timed out");
    throw new ComputerError("artifact_derivation_failed", error instanceof Error ? error.message : String(error));
  }
}
