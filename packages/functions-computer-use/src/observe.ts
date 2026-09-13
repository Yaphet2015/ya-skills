// Window selection and AX element projection with privacy rules.

export interface AxElement {
  role?: string;
  label?: string;
  value?: string | null;
  elementToken?: string;
  frame?: { x: number; y: number; w: number; h: number };
  enabled?: boolean;
}

export interface WindowRef {
  pid: number;
  windowId: bigint;
  title: string;
}

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
      `ambiguous: ${windows.length} windows — pass --window (available: ${windows
        .map((w) => `${w.windowId}:${w.title || "(untitled)"}`)
        .join(", ")})`
    );
  }
  return windows[0]!;
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
