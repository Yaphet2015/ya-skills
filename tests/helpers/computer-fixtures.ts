// Desktop-free test fixtures for the observation/batch/point-click surfaces.
// Synthetic PNGs and fake backends only — no SDK, no desktop.

import type { AxElement, Backend, NativeObservationLike, Target } from "../../packages/computer-runtime/src/types.js";

// 8x8 valid grayscale PNG (base64), embedded so tests never need an encoder.
export const SYNTHETIC_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAHUlEQVR4nGP8z8Dwn4GBgYGJgYGBYQoA/2IBHQATKwAAAABJRU5ErkJggg==";

export function syntheticPngBuffer(): Buffer {
  return Buffer.from(SYNTHETIC_PNG_BASE64, "base64");
}

export const FIXTURE_TARGET: Target = { pid: 4242, windowId: 12345n };

export interface NativeObservationOverrides {
  target?: Target;
  elements?: Array<Record<string, unknown>>;
  degraded?: boolean;
  degradedReason?: string;
  truncated?: boolean;
  truncationReason?: string;
  elementsComplete?: boolean;
  totalElementCount?: bigint;
  returnedElementCount?: bigint;
  filteredElementCount?: bigint;
  windowTitle?: string;
  windowBounds?: { x: number; y: number; width: number; height: number };
  screenshotWidth?: number;
  screenshotHeight?: number;
  screenshotScale?: number;
  screenshotMimeType?: string;
  screenshotFrameValid?: boolean;
  images?: Array<{ mimeType: string; dataBase64: string }>;
}

let observationCounter = 0;

// A fixed, deterministic raw observation: 1280x800 image metadata (2x Retina
// for a 640x400 point window at a non-zero origin) and two AX elements.
export function makeNativeObservation(overrides: NativeObservationOverrides = {}): NativeObservationLike {
  const target = overrides.target ?? FIXTURE_TARGET;
  observationCounter += 1;
  return {
    pid: target.pid,
    windowId: target.windowId,
    snapshotId: `snap-${observationCounter}`,
    appName: "FixtureApp",
    windowTitle: overrides.windowTitle ?? "Fixture Window",
    elements: overrides.elements ?? [
      { elementIndex: 0n, role: "AXWindow", label: "Fixture Window", depth: 0, frame: { x: 80, y: 40, w: 640, h: 400 } },
      { elementIndex: 1n, role: "AXButton", label: "Save", depth: 2, elementToken: "tok-save", frame: { x: 100, y: 60, w: 60, h: 24 } }
    ],
    totalElementCount: overrides.totalElementCount ?? 2n,
    returnedElementCount: overrides.returnedElementCount ?? 2n,
    filteredElementCount: overrides.filteredElementCount ?? 2n,
    elementsComplete: "elementsComplete" in overrides ? overrides.elementsComplete : true,
    degraded: overrides.degraded,
    degradedReason: overrides.degradedReason,
    truncated: overrides.truncated,
    truncationReason: overrides.truncationReason,
    screenshotWidth: overrides.screenshotWidth ?? 1280,
    screenshotHeight: overrides.screenshotHeight ?? 800,
    screenshotScale: overrides.screenshotScale ?? 2,
    screenshotMimeType: overrides.screenshotMimeType ?? "image/png",
    screenshotFrameValid: overrides.screenshotFrameValid ?? true,
    windowBounds: overrides.windowBounds ?? { x: 80, y: 40, width: 640, height: 400 },
    images: overrides.images ?? [{ mimeType: "image/png", dataBase64: SYNTHETIC_PNG_BASE64 }],
    observationId: `obs-${observationCounter}-${Math.random().toString(36).slice(2, 8)}`,
    capturedAt: Date.now(),
    epoch: `epoch-${observationCounter}`,
    revision: 0
  };
}

export function unexpected(name: string): () => never {
  return () => {
    throw new Error(`unexpected backend call: ${name}`);
  };
}

// Partial<Backend> in, full Backend out. Unlisted methods throw; every
// override's side effects stay in the caller's arrays. No real SDK fallback.
export function fakeBackendFactory(overrides: Partial<Backend> = {}): () => Promise<Backend> {
  return async () => {
    const base: Backend = {
      apps: unexpected("apps"),
      windows: unexpected("windows"),
      snapshot: unexpected("snapshot"),
      observe: unexpected("observe"),
      clickToken: unexpected("clickToken"),
      clickPoint: unexpected("clickPoint"),
      setValue: unexpected("setValue"),
      type: unexpected("type"),
      key: unexpected("key"),
      scroll: unexpected("scroll"),
      metadata: async () => ({ driverVersion: "test", pid: 1 }),
      permissions: async () => ({ accessibility: true, screenRecording: true }),
      endSession: async () => undefined,
      shutdown: async () => undefined,
      destroy: () => undefined
    };
    return { ...base, ...overrides };
  };
}

export function fixtureElements(): AxElement[] {
  return [
    { role: "AXWindow", label: "Fixture Window" },
    { role: "AXButton", label: "Save", elementToken: "tok-save", frame: { x: 100, y: 60, w: 60, h: 24 } }
  ];
}
