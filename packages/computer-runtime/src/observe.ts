// Window selection, AX element projection, privacy rules, and the independent
// channel observation projection (agentic plan A2).

import type {
  AxChannel,
  AxElement,
  ChannelStatus,
  ImageChannel,
  ImageGeometry,
  NativeObservationLike,
  ObserveOptions,
  Observation,
  Target,
  WindowRef
} from "./types.js";

export function selectWindow(windows: WindowRef[], requestedId?: bigint): WindowRef {
  if (requestedId !== undefined) {
    const hit = windows.find((w) => w.windowId === requestedId);
    if (!hit) {
      throw new Error(
        `window ${requestedId} not found for pid (available: ${windows
          .map((w) => `${w.windowId}:${w.title || "(untitled)"}`)
          .join(", ")})`
      );
    }
    return hit;
  }
  if (windows.length === 0) {
    throw new Error(
      "no usable window — the app may be starting, or its AX tree is suspended (minimized/occluded); ask the user to surface the window"
    );
  }
  if (windows.length > 1) {
    throw new Error(
      `ambiguous: ${windows.length} windows — pass a window id (available: ${windows
        .map((w) => `${w.windowId}:${w.title || "(untitled)"}`)
        .join(", ")})`
    );
  }
  return windows[0]!;
}

// Raw driver element lists -> AxElement[]. Non-string scalars become strings
// (numbers must not be dropped); nullish values stay absent.
export function normalizeElements(raw: unknown): AxElement[] {
  if (!Array.isArray(raw)) return [];
  const out: AxElement[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const e = item as Record<string, unknown>;
    out.push({
      role: typeof e.role === "string" ? e.role : undefined,
      label: typeof e.label === "string" ? e.label : undefined,
      value:
        typeof e.value === "string"
          ? e.value
          : e.value == null
            ? undefined
            : String(e.value),
      elementToken: typeof e.elementToken === "string" ? e.elementToken : undefined,
      frame:
        typeof e.frame === "object" && e.frame !== null
          ? (e.frame as { x: number; y: number; w: number; h: number })
          : undefined,
      enabled: typeof e.enabled === "boolean" ? e.enabled : undefined
    });
  }
  return out;
}

// Password fields never echo values into any output path.
export function sanitizeElements(elements: AxElement[]): AxElement[] {
  const SECRET_ROLE = /password|secure/i;
  const SECRET_LABEL = /密码|passphrase|password|secret/i;
  return elements.map((e) => {
    if (SECRET_ROLE.test(e.role ?? "") || SECRET_LABEL.test(e.label ?? "")) {
      return { ...e, value: undefined };
    }
    return e;
  });
}

export function bigintSafeReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

// ---------------------------------------------------------------------------
// Independent channel projection (A2). The raw layer never throws on a
// degraded channel; validity is decided per channel and surfaced as status.

function projectAx(raw: NativeObservationLike): AxChannel {
  const total = raw.totalElementCount === undefined ? undefined : Number(raw.totalElementCount);
  const returned = raw.returnedElementCount === undefined ? undefined : Number(raw.returnedElementCount);
  const complete = raw.elementsComplete === true && raw.degraded !== true && raw.truncated !== true;
  let status: ChannelStatus;
  let reason: string | undefined;
  if (raw.degraded === true) {
    status = "degraded";
    reason = raw.degradedReason;
  } else if (raw.truncated === true) {
    status = "truncated";
    reason = raw.truncationReason;
  } else if (raw.elementsComplete !== true) {
    // Native evidence (verification doc §“native evidence reports truncation
    // with elementsComplete=false and no truncated flag”): an incomplete tree
    // is NEVER usable — partial trees cannot prove existence/value
    // conditions, so incompleteness keeps its own truncated status.
    status = "truncated";
    reason = raw.truncationReason ?? "elements_incomplete";
  } else {
    status = "usable";
  }
  const elements = sanitizeElements(normalizeElements(raw.elements));
  if (status === "usable" && elements.length === 0) {
    status = "empty";
    reason = "no_accessibility_elements";
  }
  const returnedCount = returned ?? elements.length;
  return {
    status,
    ...(reason !== undefined ? { reason } : {}),
    elements,
    total: total ?? returnedCount,
    returned: returnedCount,
    complete
  };
}

function projectImage(raw: NativeObservationLike): ImageChannel {
  // Usable image evidence means ACTUAL non-empty image content (not merely
  // the presence of an images array) plus full geometry.
  const dataBase64 = raw.images?.[0]?.dataBase64;
  const hasImage =
    (typeof dataBase64 === "string" && dataBase64.length > 0) ||
    (typeof raw.screenshotFilePath === "string" && raw.screenshotFilePath.length > 0);
  const dimsPresent =
    typeof raw.screenshotWidth === "number" && Number.isFinite(raw.screenshotWidth) && raw.screenshotWidth > 0 &&
    typeof raw.screenshotHeight === "number" && Number.isFinite(raw.screenshotHeight) && raw.screenshotHeight > 0;
  if (!hasImage && !dimsPresent) {
    return { status: "unavailable" };
  }
  if (!hasImage) {
    return { status: "empty" };
  }
  if (raw.screenshotFrameValid === false) {
    return { status: "degraded", reason: "frame_invalid", frameValid: false };
  }
  if (!dimsPresent || raw.windowBounds === undefined) {
    return { status: "degraded", reason: "geometry_missing" };
  }
  const bounds = raw.windowBounds;
  if (
    !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) ||
    !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height) ||
    bounds.width <= 0 || bounds.height <= 0
  ) {
    return { status: "degraded", reason: "geometry_invalid" };
  }
  const geometry: ImageGeometry = {
    sourceWidth: raw.screenshotWidth!,
    sourceHeight: raw.screenshotHeight!,
    sentWidth: raw.screenshotWidth!,
    sentHeight: raw.screenshotHeight!,
    // inputBounds is the WINDOW-LOCAL input-coordinate rect the image covers
    // (full-window captures: origin 0,0; sizes in points). windowBounds stays
    // screen-global for change detection (A1 probe: frames are global points).
    inputBounds: { x: 0, y: 0, width: bounds.width, height: bounds.height },
    windowBounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
  };
  // frameValid is passed through VERBATIM — absent metadata is reported as
  // absent (undefined), never fabricated as true.
  return {
    status: "usable",
    ...(raw.screenshotFrameValid !== undefined ? { frameValid: raw.screenshotFrameValid } : {}),
    geometry
  };
}

function selectorMatches(selector: { text: string; match: "exact" | "contains"; role?: string }, e: AxElement): boolean {
  if (selector.role !== undefined && e.role !== selector.role) return false;
  const wanted = normalizeTextForSelector(selector.text);
  const label = e.label == null ? null : normalizeTextForSelector(e.label);
  const value = e.value == null || e.value === "" ? null : normalizeTextForSelector(e.value);
  if (selector.match === "exact") return label === wanted || value === wanted;
  return (label !== null && label.includes(wanted)) || (value !== null && value.includes(wanted));
}

function normalizeTextForSelector(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Project one raw read into the public Observation. `requested` says which
 * channels this read actually asked for — an unrequested channel is
 * "unavailable", never "empty". The caller (session) fills image paths and
 * identity metadata; this function never invents data and never throws on
 * degraded channels. */
export function projectObservation(
  raw: NativeObservationLike,
  options: ObserveOptions,
  requested: { accessibility: boolean; screenshot: boolean } = { accessibility: true, screenshot: true }
): Observation {
  const ax = requested.accessibility ? projectAx(raw) : { status: "unavailable" as ChannelStatus, elements: [], total: 0, returned: 0, complete: false };
  const image = requested.screenshot ? projectImage(raw) : ({ status: "unavailable" as ChannelStatus } as ImageChannel);
  if (options.selector && ax.status === "usable") {
    const filtered = ax.elements.filter((e) => selectorMatches(options.selector!, e));
    ax.elements = filtered;
    ax.returned = filtered.length;
    // A filtered view is not a complete view of the window.
    ax.complete = false;
  }
  return {
    id: raw.observationId,
    target: { pid: raw.pid, windowId: raw.windowId },
    capturedAt: raw.capturedAt,
    epoch: raw.epoch,
    revision: raw.revision,
    title: raw.windowTitle ?? "",
    ax,
    image
  };
}

export { selectorMatches };
