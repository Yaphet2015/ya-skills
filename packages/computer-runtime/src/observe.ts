// Window selection, AX element projection, and privacy rules.

import type { AxElement, WindowRef } from "./types.js";

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
