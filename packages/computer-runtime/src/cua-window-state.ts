// The generic SDK result preserves platform AX extensions that the generated
// WindowElement contract does not yet expose. Convert only the window metadata
// we consume; element projection/privacy remain in observe.ts.
import { ComputerError } from "./driver-result.js";
import type { NativeObservationLike, Target, ToolResultLike } from "./types.js";

type WindowState = Omit<NativeObservationLike, "observationId" | "capturedAt" | "epoch" | "revision">;

function invalid(): never {
  throw new ComputerError("invalid_driver_result", "get_window_state returned invalid window metadata");
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}

function integer(value: unknown): bigint {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return invalid();
}

export function decodeWindowState(result: ToolResultLike, target: Target): WindowState {
  if (result.isError) {
    throw new ComputerError(result.errorCode ?? "observation_failed", "get_window_state was refused by the driver");
  }
  let raw: Record<string, unknown>;
  try {
    raw = record(JSON.parse(result.structuredJson ?? "", (key, value, context?: { source: string }) => {
      // Newer runtimes expose the original JSON number lexeme. Never accept
      // an already rounded uint64 on runtimes that lack that extension.
      if (key === "window_id" && typeof value === "number" && context?.source) return integer(context.source);
      return value;
    }));
  } catch { return invalid(); }
  if (raw.pid !== target.pid || integer(raw.window_id) !== target.windowId) return invalid();
  if (raw.elements !== undefined && !Array.isArray(raw.elements)) return invalid();
  const state: Record<string, unknown> = {
    pid: target.pid,
    windowId: target.windowId,
    elements: raw.elements,
    images: result.images ?? []
  };
  const fields = {
    snapshot_id: "snapshotId", app_name: "appName", window_title: "windowTitle",
    degraded_reason: "degradedReason", truncation_reason: "truncationReason",
    screenshot_mime_type: "screenshotMimeType", screenshot_file_path: "screenshotFilePath"
  };
  for (const [native, key] of Object.entries(fields)) {
    if (raw[native] == null) continue;
    if (typeof raw[native] !== "string") return invalid();
    state[key] = raw[native];
  }
  for (const [native, key] of Object.entries({
    elements_complete: "elementsComplete", degraded: "degraded", truncated: "truncated",
    screenshot_frame_valid: "screenshotFrameValid"
  })) {
    if (raw[native] == null) continue;
    if (typeof raw[native] !== "boolean") return invalid();
    state[key] = raw[native];
  }
  for (const [native, key] of Object.entries({
    total_element_count: "totalElementCount", returned_element_count: "returnedElementCount",
    filtered_element_count: "filteredElementCount"
  })) {
    if (raw[native] != null) state[key] = integer(raw[native]);
  }
  for (const [native, key] of Object.entries({
    screenshot_width: "screenshotWidth", screenshot_height: "screenshotHeight", screenshot_scale: "screenshotScale"
  })) {
    if (raw[native] == null) continue;
    if (typeof raw[native] !== "number" || !Number.isFinite(raw[native])) return invalid();
    state[key] = raw[native];
  }
  if (raw.window_bounds != null) {
    const bounds = record(raw.window_bounds);
    const windowBounds: Record<string, number> = {};
    for (const key of ["x", "y", "width", "height"]) {
      const value = bounds[key];
      if (typeof value !== "number" || !Number.isFinite(value)) return invalid();
      windowBounds[key] = value;
    }
    state.windowBounds = windowBounds;
  }
  return state as unknown as WindowState;
}
