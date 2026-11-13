// Real Cua backend: SDK input construction, background delivery, degraded
// detection, wake-once AX exposure. This is the only place that knows the
// driver's concrete API shapes.

import { spawnSync } from "node:child_process";
import type {
  AppRef,
  Backend,
  NativeInputAddress,
  NativeActionOptions,
  NativeObservationLike,
  ObserveCallOptions,
  Point,
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
import { decodeWindowState } from "./cua-window-state.js";
import { isKnownDriverRefusal, parseActionResult } from "./driver-result.js";

type Sdk = typeof import("@trycua/cua-driver");

// Minimal driver surface (structural typing keeps the compiled sidecar load
// opaque to the type system).
interface DriverLike {
  listApps(input: never): Promise<{ apps?: Array<Record<string, unknown>> }>;
  listWindows(input: never): Promise<{ windows?: Array<{ pid: number; windowId: bigint; title: string }> }>;
  /** Full tool contract, including input addressing absent from typed inputs. */
  callTool(name: string, argumentsJson: string, callOptions?: { signal: AbortSignal }): Promise<ToolResultLike>;
  click(input: never): Promise<ToolResultLike | void>;
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

function wakeAxOnce(
  pid: number,
  seen: Set<number>,
  callOptions?: ObserveCallOptions
): void {
  if (seen.has(pid)) return;
  if (callOptions?.signal?.aborted) {
    throw new ComputerError("aborted", "the observation was aborted");
  }
  seen.add(pid);
  const jxa = [
    "ObjC.import('ApplicationServices');",
    `const app = $.AXUIElementCreateApplication(${pid});`,
    "$.AXUIElementSetAttributeValue(app, 'AXManualAccessibility', true);",
    "$.AXUIElementSetAttributeValue(app, 'AXEnhancedUserInterface', true);",
    "'ok';"
  ].join("\n");
  const remaining = callOptions?.deadlineAt === undefined
    ? WAKE_BUDGET_MS
    : Math.min(WAKE_BUDGET_MS, Math.max(1, callOptions.deadlineAt - Date.now()));
  spawnSync("osascript", ["-l", "JavaScript", "-e", jxa], { stdio: "ignore", timeout: remaining });
  if (callOptions?.signal?.aborted) {
    throw new ComputerError("aborted", "the observation was aborted");
  }
  if (callOptions?.deadlineAt !== undefined && Date.now() >= callOptions.deadlineAt) {
    throw new ComputerError("command_timeout", "the observation budget expired while preparing accessibility data");
  }
}

function inputFields(input?: NativeInputAddress): Record<string, unknown> {
  if (input?.elementToken !== undefined) return { element_token: input.elementToken };
  if (input?.point !== undefined) return { x: input.point.x, y: input.point.y };
  return {};
}

/** JSON integers must preserve all 64 window-id bits. Only the validated
 * numeric identity is emitted as a literal; all user data uses JSON.stringify. */
function windowIdentity(target: Target): string {
  if (!Number.isSafeInteger(target.pid) || target.pid <= 0 || typeof target.windowId !== "bigint" || target.windowId < 0n) {
    throw new ComputerError("invalid_request", "invalid native window target", "not_delivered");
  }
  return `"pid":${target.pid},"window_id":${target.windowId}`;
}

function actionFields(options?: NativeActionOptions): Record<string, unknown> {
  return options?.postActionWait === "none" ? { post_action_wait: "none" } : {};
}

async function callWindowTool(
  driver: Pick<DriverLike, "callTool">,
  name: string,
  target: Target,
  fields: Record<string, unknown>,
  options?: NativeActionOptions
): Promise<ToolResultLike> {
  const body = JSON.stringify({ ...fields, delivery_mode: "background", ...actionFields(options) });
  const identity = `"target":{"kind":"window",${windowIdentity(target)}}`;
  const result = await driver.callTool(name, `{${identity},${body.slice(1)}`);
  // Typed click raises DriverError.Tool on failure. Its generic fast route
  // must keep the same conservative delivery verdict if action metadata is
  // missing: an arbitrary tool error does not prove input was never sent.
  if (name === "click" && result.isError && parseActionResult(result) === undefined &&
      !isKnownDriverRefusal({ tag: "Tool", inner: { errorCode: result.errorCode } })) {
    throw new ComputerError("action_failed", "native click failed without delivery metadata", "unknown");
  }
  return result;
}

export function makeBackend(sdk: Sdk, driver: DriverLike, prepareAccessibility = wakeAxOnce): Backend {
  const woken = new Set<number>();
  const windowTarget = (target: Target) =>
    new sdk.ActionTarget.Window({ pid: target.pid, windowId: target.windowId });

  const readWindow = async (
    target: Target,
    accessibility: boolean,
    screenshot: boolean,
    maxDimension?: number,
    callOptions?: ObserveCallOptions
  ) => {
    prepareAccessibility(target.pid, woken, callOptions);
    const fields = JSON.stringify({
      include_accessibility_tree: accessibility,
      include_screenshot: screenshot,
      // Preserve the typed SDK's full AX scope, including menu descendants.
      full_output: true,
      screenshot_format: "png",
      ...(maxDimension !== undefined ? { max_dimension: maxDimension } : {})
    });
    const result = await driver.callTool(
      "get_window_state", `{${windowIdentity(target)},${fields.slice(1)}`,
      callOptions?.signal === undefined ? undefined : { signal: callOptions.signal }
    );
    return decodeWindowState(result, target);
  };

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
      prepareAccessibility(pid, woken);
      const res = await driver.listWindows(sdk.ListWindowsInput.new({ pid, onScreenOnly }) as never);
      return (res.windows ?? [])
        .filter((w) => w.pid === pid)
        .map((w) => ({ pid, windowId: w.windowId, title: w.title }));
    },

    async snapshot(target: Target, screenshot: boolean): Promise<Snapshot> {
      const state = await readWindow(target, true, screenshot);
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

    // Agentic observation path: unlike snapshot(), degraded AX is NOT an
    // error here — channels are returned as the driver produced them and
    // validity is projected per channel (see observe.ts). Verified A1 facts:
    // windowBounds/screenshot dims only come back with the screenshot
    // channel; at least one channel is required (InvalidArguments otherwise).
    async observe(
      target: Target,
      options: { accessibility: boolean; screenshot: boolean; maxDimension?: number },
      callOptions?: ObserveCallOptions
    ): Promise<NativeObservationLike> {
      if (!options.accessibility && !options.screenshot) {
        throw new ComputerError(
          "invalid_request",
          "observe requires at least one channel (accessibility or screenshot)"
        );
      }
      const state = await readWindow(target, options.accessibility, options.screenshot, options.maxDimension, callOptions);
      if (callOptions?.signal?.aborted) {
        throw new ComputerError("aborted", "the observation was aborted");
      }
      if (callOptions?.deadlineAt !== undefined && Date.now() >= callOptions.deadlineAt) {
        throw new ComputerError("command_timeout", "the observation budget expired");
      }
      return state as unknown as NativeObservationLike;
    },

    // Window-local PIXEL coordinates (screenshot space, top-left origin) —
    // the unit verified by the A1 probe. The session layer maps/validates
    // observation coordinates into this space before calling.
    async clickPoint(target: Target, point: Point, options?: NativeActionOptions): Promise<ToolResultLike> {
      if (options?.postActionWait === "none") {
        return callWindowTool(driver, "click", target, { x: point.x, y: point.y, button: "left", count: 1 }, options);
      }
      const result = await driver.click(
        sdk.ClickInput.new({
          target: windowTarget(target),
          position: new sdk.ClickPosition.Coordinates({ x: point.x, y: point.y }),
          deliveryMode: sdk.InputDeliveryMode.Background,
          button: sdk.ClickButton.Left,
          count: 1
        }) as never
      );
      return (result ?? { isError: false }) as ToolResultLike;
    },

    async clickToken(target: Target, token: string, options?: NativeActionOptions): Promise<ToolResultLike> {
      if (options?.postActionWait === "none") {
        return callWindowTool(driver, "click", target, { element_token: token, button: "left", count: 1 }, options);
      }
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

    // `set_value` writes the token's AXValue directly. This adapter never
    // calls typeText or any event-injection primitive for this operation.
    async setValue(target: Target, elementToken: string, value: string, options?: NativeActionOptions): Promise<ToolResultLike> {
      return driver.callTool(
        "set_value",
        JSON.stringify({ pid: target.pid, element_token: elementToken, value, ...actionFields(options) })
      );
    },

    async type(target: Target, text: string, input?: NativeInputAddress, options?: NativeActionOptions): Promise<ToolResultLike> {
      return callWindowTool(driver, "type_text", target, { text, ...inputFields(input) }, options);
    },

    async key(target: Target, key: string, modifiers?: string[], input?: NativeInputAddress, options?: NativeActionOptions): Promise<ToolResultLike> {
      return callWindowTool(driver, "press_key", target, {
        key,
        ...(modifiers ? { modifiers } : {}),
        ...inputFields(input)
      }, options);
    },

    async scroll(target: Target, spec: ScrollSpec, options?: NativeActionOptions): Promise<ToolResultLike> {
      return callWindowTool(driver, "scroll", target, {
        x: spec.x, y: spec.y, direction: spec.direction, amount: spec.amount
      }, options);
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
        // The SDK otherwise prefers an installed daemon, whose protocol may differ.
        const driver = realSdk.CuaDriver.create({
          embedded: true,
          claudeCodeCompatibility: false
        }) as unknown as DriverLike;
        return makeBackend(realSdk, driver);
      }
    },
    options
  );
}
