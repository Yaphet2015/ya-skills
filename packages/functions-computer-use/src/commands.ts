import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { FunctionCommand } from "@ya-skills/core";
import { parseRequest, type ParsedRequest } from "./args.js";
import { runDoctor, withDriver, loadSdk, COMMAND_DEADLINE_MS } from "./runtime.js";
import { selectWindow, sanitizeElements, bigintSafeReplacer, type AxElement, type WindowRef } from "./observe.js";
import { clickWith, clickPredicate } from "./act.js";
import { ensureOutDir, artifactPath } from "./artifacts.js";

// Commands own validation, orchestration, and result envelopes. Driver calls
// happen inside withDriver (bounded deadline, ordered cleanup). Success prints
// one JSON value on stdout; post-driver failures throw Error with a JSON body.

type DriverLike = {
  listApps(input: never): Promise<{ apps?: Array<Record<string, unknown>> }>;
  listWindows(input: never): Promise<{ windows?: Array<{ pid: number; windowId: bigint; title: string }> }>;
  getWindowState(input: never): Promise<{
    degraded?: boolean;
    truncated?: boolean;
    windowTitle?: string;
    elements?: Array<Record<string, unknown>>;
    images?: Array<{ dataBase64?: string }>;
  }>;
  click(input: never): Promise<unknown>;
  typeText(input: never): Promise<{ isError?: boolean; text?: string }>;
  pressKey(input: never): Promise<{ isError?: boolean; text?: string }>;
  scroll(input: never): Promise<{ isError?: boolean; text?: string }>;
  endSession(input: never): Promise<unknown>;
  shutdown(): Promise<unknown>;
  uniffiDestroy?(): void;
};

function jsonError(code: string, message: string, extra: Record<string, unknown> = {}): Error {
  return new Error(JSON.stringify({ error: { code, message, ...extra } }, bigintSafeReplacer));
}

// macOS suspends AX trees of minimized/occluded windows. Background-first:
// wake Chromium-family AX exposure at runtime (no focus change) instead of
// activating the app. Native windows that stay suspended are surfaced by the
// snapshot error, telling the agent to ask the user — never to auto-activate.
function wakeAx(pid: number): void {
  const jxa = [
    "ObjC.import('ApplicationServices');",
    `const app = $.AXUIElementCreateApplication(${pid});`,
    "$.AXUIElementSetAttributeValue(app, 'AXManualAccessibility', true);",
    "$.AXUIElementSetAttributeValue(app, 'AXEnhancedUserInterface', true);",
    "'ok';"
  ].join("\n");
  spawnSync("osascript", ["-l", "JavaScript", "-e", jxa], { stdio: "ignore" });
}

function activate(pid: number): void {
  spawnSync("osascript", [
    "-e",
    `tell application "System Events" to set frontmost of first process whose unix id is ${pid} to true`
  ]);
  spawnSync("sleep", ["0.6"]);
}

async function listWindows(driver: DriverLike, pid: number): Promise<WindowRef[]> {
  const res = await driver.listWindows({ pid, onScreenOnly: false } as never);
  return (res.windows ?? []).filter((w) => w.pid === pid).map((w) => ({ pid, windowId: w.windowId, title: w.title }));
}

async function snapshot(
  driver: DriverLike,
  pid: number,
  windowId: bigint,
  withShot: boolean
): Promise<{ elements: AxElement[]; imageBase64?: string; windowTitle: string }> {
  const state = await driver.getWindowState({
    pid,
    windowId,
    includeAccessibilityTree: true,
    includeScreenshot: withShot
  } as never);
  if (state.degraded || state.truncated) {
    throw jsonError(
      "degraded_snapshot",
      `window snapshot degraded=${state.degraded} truncated=${state.truncated} — the window is likely hidden/occluded and its AX tree suspended; ask the user to surface it, do NOT --activate around it silently`
    );
  }
  const elements = (state.elements ?? []).map((e) => ({
    role: typeof e.role === "string" ? e.role : undefined,
    label: typeof e.label === "string" ? e.label : undefined,
    value: typeof e.value === "string" ? e.value : undefined,
    elementToken: typeof e.elementToken === "string" ? e.elementToken : undefined,
    frame:
      typeof e.frame === "object" && e.frame !== null
        ? (e.frame as { x: number; y: number; w: number; h: number })
        : undefined,
    enabled: typeof e.enabled === "boolean" ? e.enabled : undefined
  }));
  const image = withShot ? state.images?.[0]?.dataBase64 : undefined;
  return { elements: sanitizeElements(elements), imageBase64: image, windowTitle: state.windowTitle ?? "" };
}

async function perceiveEnvelope(
  driver: DriverLike,
  pid: number,
  win: WindowRef,
  shot: boolean,
  outDir: string | undefined
): Promise<string> {
  const snap = await snapshot(driver, pid, win.windowId, shot);
  const payload: Record<string, unknown> = {
    pid,
    windowId: win.windowId,
    title: snap.windowTitle || win.title,
    elements: snap.elements
  };
  if (snap.imageBase64) {
    const dir = ensureOutDir(outDir);
    const file = artifactPath(dir, "cu.png");
    writeFileSync(file, Buffer.from(snap.imageBase64, "base64"), { mode: 0o600 });
    payload.screenshot = file;
  }
  return JSON.stringify(payload, bigintSafeReplacer);
}

async function runReal(request: ParsedRequest): Promise<string> {
  const platform = process.platform === "darwin" && process.arch === "arm64";
  if (!platform) {
    throw jsonError("unsupported_platform", `computer-use requires macOS arm64 (this machine: ${process.platform} ${process.arch})`);
  }
  return withDriver({
    load: async () => {
      const sdk = await loadSdk();
      return sdk as unknown as { CuaDriver: { create(o: unknown): unknown } };
    },
    create: async () => (await loadSdk()).CuaDriver.create(undefined) as unknown as DriverLike,
    work: async (rawDriver) => {
      const driver = rawDriver as unknown as DriverLike;
      switch (request.kind) {
        case "apps": {
          const res = await driver.listApps({} as never);
          let apps = (res.apps ?? []).map((a) => ({
            pid: a.pid,
            name: a.name,
            running: a.running,
            active: a.active,
            bundleId: a.bundleId
          }));
          if (request.name) {
            const n = request.name.toLowerCase();
            apps = apps.filter((a) => String(a.name ?? "").toLowerCase().includes(n));
          }
          return JSON.stringify({ apps });
        }
        case "windows": {
          const wins = await listWindows(driver, request.pid);
          return JSON.stringify({ windows: wins.map((w) => ({ windowId: w.windowId, title: w.title })) }, bigintSafeReplacer);
        }
        case "perceive": {
          if (request.activate) activate(request.pid);
          wakeAx(request.pid);
          const wins = await listWindows(driver, request.pid);
          const win = selectWindow(wins, request.windowId);
          return await perceiveEnvelope(driver, request.pid, win, request.shot, request.outDir);
        }
        case "act": {
          if (request.activate) activate(request.pid);
          wakeAx(request.pid);
          const wins = await listWindows(driver, request.pid);
          const win = selectWindow(wins, request.windowId);

          // --- the ONE action ---
          if (request.action === "click") {
            await clickWith(
              {
                snapshot: async () => (await snapshot(driver, request.pid, win.windowId, false)).elements,
                click: async (elementToken) => {
                  const { ActionTarget, ClickInput, ClickPosition, InputDeliveryMode, ClickButton } =
                    await loadSdk();
                  await driver.click(
                    ClickInput.new({
                      target: new ActionTarget.Window({ pid: request.pid, windowId: win.windowId }),
                      position: new ClickPosition.Element({ elementToken }),
                      deliveryMode: InputDeliveryMode.Background,
                      button: ClickButton.Left,
                      count: 1
                    }) as never
                  );
                }
              },
              clickPredicate(request.click),
              `click ${request.click.role ?? ""} "${request.click.text}"`
            );
          } else if (request.action === "type") {
            const { ActionTarget, TypeTextInput } = await loadSdk();
            const result = await driver.typeText(
              TypeTextInput.new({
                target: new ActionTarget.Window({ pid: request.pid, windowId: win.windowId }),
                text: request.type
              }) as never
            );
            if (result.isError) {
              throw jsonError("action_refused", `type was refused: ${result.text ?? "no detail"}`);
            }
          } else if (request.action === "key") {
            const { ActionTarget, PressKeyInput } = await loadSdk();
            const result = await driver.pressKey(
              PressKeyInput.new({
                target: new ActionTarget.Window({ pid: request.pid, windowId: win.windowId }),
                key: request.key
              }) as never
            );
            if (result.isError) {
              throw jsonError("action_refused", `key was refused: ${result.text ?? "no detail"}`);
            }
          } else {
            const { ActionTarget, ScrollInput, ScrollDirection } = await loadSdk();
            const dir = {
              up: ScrollDirection.Up,
              down: ScrollDirection.Down,
              left: ScrollDirection.Left,
              right: ScrollDirection.Right
            }[request.scroll.direction];
            const result = await driver.scroll(
              ScrollInput.new({
                x: request.scroll.x,
                y: request.scroll.y,
                direction: dir,
                target: new ActionTarget.Window({ pid: request.pid, windowId: win.windowId }),
                amount: BigInt(request.scroll.amount)
              }) as never
            );
            if (result.isError) {
              throw jsonError("action_refused", `scroll was refused: ${result.text ?? "no detail"}`);
            }
          }

          // --- post-action perception for the agent's NEXT decision ---
          try {
            return await perceiveEnvelope(driver, request.pid, win, request.shot, request.outDir);
          } catch (e) {
            const inner = e instanceof Error ? e.message : String(e);
            throw jsonError(
              "post_action_observe_failed",
              `the action was delivered but re-perceiving failed: ${inner}`,
              { actionDelivered: true, nextStep: "run perceive; do NOT repeat the act" }
            );
          }
        }
        default:
          throw jsonError("internal", `unhandled request kind`);
      }
    }
  });
}

export function createComputerUseCommands(): FunctionCommand[] {
  const domain = "computer-use";
  const run = (action: string) => async (args: string[]): Promise<string> => {
    const request = parseRequest(action, args);
    return runReal(request);
  };
  return [
    {
      domain,
      action: "doctor",
      description: "Check platform, runtime files, driver load, and read-only permission status.",
      run: async () => {
        const report = await runDoctor();
        const json = JSON.stringify(report, null, 2);
        if (!report.ok) {
          throw new Error(`doctor found problems:\n${json}`);
        }
        return json;
      }
    },
    { domain, action: "apps", description: "List running apps (pid, name) with optional --name substring filter.", run: run("apps") },
    { domain, action: "windows", description: "List windows for a --pid (windowId as decimal string, title).", run: run("windows") },
    { domain, action: "perceive", description: "Read AX elements (and optional screenshot) of a window for the next decision.", run: run("perceive") },
    { domain, action: "act", description: "Perform one background action (click/type/key/scroll), then re-perceive.", run: run("act") }
  ];
}

export const CU_COMMAND_DEADLINE_MS = COMMAND_DEADLINE_MS;
