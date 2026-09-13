// Real Cua backend: SDK input construction, background delivery, degraded
// detection, wake-once AX exposure. This is the only place that knows the
// driver's concrete API shapes.

import { spawnSync } from "node:child_process";
import type {
  AppRef,
  Backend,
  ScrollDirection,
  ScrollSpec,
  Snapshot,
  Target,
  ToolResultLike,
  WindowRef
} from "./types.js";
import type { ComputerSession, SessionOptions } from "./session.js";
import { ComputerError, createSessionWithBackend } from "./session.js";
import { isSupportedPlatform, loadSdk } from "./sdk.js";
import { normalizeElements, sanitizeElements } from "./observe.js";

type Sdk = typeof import("@trycua/cua-driver");

// Minimal driver surface (structural typing keeps the compiled sidecar load
// opaque to the type system).
interface DriverLike {
  listApps(input: never): Promise<{ apps?: Array<Record<string, unknown>> }>;
  listWindows(input: never): Promise<{ windows?: Array<{ pid: number; windowId: bigint; title: string }> }>;
  getWindowState(input: never): Promise<{
    degraded?: boolean;
    truncated?: boolean;
    windowTitle?: string;
    elements?: Array<Record<string, unknown>>;
    images?: Array<{ dataBase64?: string }>;
  }>;
  click(input: never): Promise<ToolResultLike | void>;
  typeText(input: never): Promise<ToolResultLike>;
  pressKey(input: never): Promise<ToolResultLike>;
  scroll(input: never): Promise<ToolResultLike>;
  metadata(): Promise<{ driverVersion?: string; pid?: number }>;
  endSession(input: never): Promise<unknown>;
  shutdown(): Promise<unknown>;
  uniffiDestroy?(): void;
}

// macOS suspends AX trees of minimized/occluded windows. Background-first:
// wake Chromium-family AX exposure at runtime (no focus change) instead of
// activating the app. Bounded spawn; cached per pid so polling loops do not
// respawn osascript every snapshot.
const WAKE_BUDGET_MS = 2_000;

function wakeAxOnce(pid: number, seen: Set<number>): void {
  if (seen.has(pid)) return;
  seen.add(pid);
  const jxa = [
    "ObjC.import('ApplicationServices');",
    `const app = $.AXUIElementCreateApplication(${pid});`,
    "$.AXUIElementSetAttributeValue(app, 'AXManualAccessibility', true);",
    "$.AXUIElementSetAttributeValue(app, 'AXEnhancedUserInterface', true);",
    "'ok';"
  ].join("\n");
  spawnSync("osascript", ["-l", "JavaScript", "-e", jxa], { stdio: "ignore", timeout: WAKE_BUDGET_MS });
}

function makeBackend(sdk: Sdk, driver: DriverLike): Backend {
  const woken = new Set<number>();
  const windowTarget = (target: Target) =>
    new sdk.ActionTarget.Window({ pid: target.pid, windowId: target.windowId });

  return {
    async apps(): Promise<AppRef[]> {
      const res = await driver.listApps(sdk.ListAppsInput.new({}) as never);
      return (res.apps ?? []).map((a) => ({
        pid: a.pid as number,
        name: a.name as string,
        bundleId: a.bundleId as string | undefined,
        running: a.running as boolean | undefined,
        active: a.active as boolean | undefined
      }));
    },

    async windows(pid: number, onScreenOnly = false): Promise<WindowRef[]> {
      wakeAxOnce(pid, woken);
      const res = await driver.listWindows(sdk.ListWindowsInput.new({ pid, onScreenOnly }) as never);
      return (res.windows ?? [])
        .filter((w) => w.pid === pid)
        .map((w) => ({ pid, windowId: w.windowId, title: w.title }));
    },

    async snapshot(target: Target, screenshot: boolean): Promise<Snapshot> {
      wakeAxOnce(target.pid, woken);
      const state = await driver.getWindowState(
        sdk.GetWindowStateInput.new({
          pid: target.pid,
          windowId: target.windowId,
          includeAccessibilityTree: true,
          includeScreenshot: screenshot
        }) as never
      );
      if (state.degraded || state.truncated) {
        throw new ComputerError(
          "degraded_snapshot",
          `window snapshot degraded=${state.degraded} truncated=${state.truncated} — the window is likely hidden/occluded and its AX tree suspended; surface the window instead of activating around it`
        );
      }
      const imageBase64 = screenshot ? state.images?.[0]?.dataBase64 : undefined;
      return {
        elements: sanitizeElements(normalizeElements(state.elements)),
        title: state.windowTitle ?? "",
        ...(imageBase64 ? { imageBase64 } : {})
      };
    },

    async clickToken(target: Target, token: string): Promise<ToolResultLike> {
      const result = await driver.click(
        sdk.ClickInput.new({
          target: windowTarget(target),
          position: new sdk.ClickPosition.Element({ elementToken: token }),
          deliveryMode: sdk.InputDeliveryMode.Background,
          button: sdk.ClickButton.Left,
          count: 1
        }) as never
      );
      return (result ?? { isError: false }) as ToolResultLike;
    },

    async type(target: Target, text: string): Promise<ToolResultLike> {
      return driver.typeText(
        sdk.TypeTextInput.new({ target: windowTarget(target), text }) as never
      );
    },

    async key(target: Target, key: string, modifiers?: string[]): Promise<ToolResultLike> {
      return driver.pressKey(
        sdk.PressKeyInput.new({
          target: windowTarget(target),
          key,
          ...(modifiers ? { modifiers } : {})
        }) as never
      );
    },

    async scroll(target: Target, spec: ScrollSpec): Promise<ToolResultLike> {
      const dir = {
        up: sdk.ScrollDirection.Up,
        down: sdk.ScrollDirection.Down,
        left: sdk.ScrollDirection.Left,
        right: sdk.ScrollDirection.Right
      }[spec.direction as ScrollDirection];
      return driver.scroll(
        sdk.ScrollInput.new({
          x: spec.x,
          y: spec.y,
          direction: dir,
          target: windowTarget(target),
          amount: BigInt(spec.amount)
        }) as never
      );
    },

    async metadata() {
      return driver.metadata();
    },

    async permissions() {
      const status = (sdk as unknown as {
        currentMacOsPermissionStatus?: () => { accessibility: boolean; screenRecording: boolean };
      }).currentMacOsPermissionStatus;
      if (typeof status !== "function") {
        return { accessibility: false, screenRecording: false };
      }
      return status.call(sdk);
    },

    async endSession() {
      await driver.endSession(sdk.EndSessionInput.new({}) as never);
    },

    async shutdown() {
      await driver.shutdown();
    },

    destroy() {
      driver.uniffiDestroy?.();
    }
  };
}

export function createComputerSession(options: SessionOptions = {}): ComputerSession {
  const platform = isSupportedPlatform(process);
  if (platform !== true) {
    throw new Error(platform);
  }
  let sdkRef: Sdk | null = null;
  return createSessionWithBackend(
    {
      load: async () => {
        sdkRef = (await loadSdk()) as Sdk;
        return sdkRef;
      },
      create: async (sdk) => {
        const realSdk = (sdk ?? sdkRef) as Sdk;
        const driver = realSdk.CuaDriver.create(undefined) as unknown as DriverLike;
        return makeBackend(realSdk, driver);
      }
    },
    options
  );
}
