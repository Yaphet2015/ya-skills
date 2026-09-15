// One-shot guarded native probe (agentic desktop plan Task A1). NOT product
// code.
//
// Guards (enforced before any SDK work):
//   - no --pid/--window target  -> the driver is NEVER started; the probe
//     prints a static no-target report and exits 0.
//   - no --allow-input          -> read-only: the probe may observe the target
//     window but can never deliver input.
//   - --click-x/--click-y       -> window-target coordinate click probe;
//     rejected unless --allow-input is also present. Delivery mode is always
//     Background; an unsupported background route is recorded as the driver's
//     raw error and never retried in the foreground.
//
// The report is an allowlist projection: geometry, screenshot scale/pixel
// size/frame validity, AX completeness counters. It never includes element
// labels/values, AX markdown, or image bytes.
//
// Usage:
//   bun scripts/probes/computer-use-agentic.ts [--help]
//   bun scripts/probes/computer-use-agentic.ts            # no-target, no driver
//   bun scripts/probes/computer-use-agentic.ts --pid P --window W [--max-dimension N]
//   bun scripts/probes/computer-use-agentic.ts --pid P --window W --allow-input \
//       --click-x X --click-y Y

export type ProbeRequest =
  | { kind: "usage" }
  | { kind: "no-target" }
  | { kind: "invalid"; reason: string }
  | {
      kind: "target";
      pid: number;
      windowId: bigint;
      inputAuthorized: boolean;
      maxDimension?: number;
      click?: { x: number; y: number };
    };

// The driver may only ever be started for a fully validated explicit target.
export function driverMustStart(request: ProbeRequest): boolean {
  return request.kind === "target";
}

export function inputAuthorized(request: ProbeRequest): boolean {
  return request.kind === "target" && request.inputAuthorized;
}

function positiveInt(value: string, flag: string): number | string {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return `${flag} expects a positive integer, got: ${value}`;
  }
  return parsed;
}

function windowId(value: string): bigint | string {
  if (!/^\d+$/.test(value)) {
    return `--window expects a decimal window id, got: ${value}`;
  }
  return BigInt(value);
}

export function parseProbeArgs(argv: string[]): ProbeRequest {
  const args = [...argv];
  let pid: number | undefined;
  let window: bigint | undefined;
  let allowInput = false;
  let maxDimension: number | undefined;
  let clickX: number | undefined;
  let clickY: number | undefined;

  if (args[0] === "--help" || args[0] === "-h") return { kind: "usage" };

  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    const value = args[i + 1];
    if (flag === "--pid") {
      const parsed = value !== undefined ? positiveInt(value, "--pid") : "--pid expects a value";
      if (typeof parsed === "string") return { kind: "invalid", reason: parsed };
      pid = parsed;
      i++;
    } else if (flag === "--window") {
      const parsed = value !== undefined ? windowId(value) : "--window expects a value";
      if (typeof parsed === "string") return { kind: "invalid", reason: parsed };
      window = parsed;
      i++;
    } else if (flag === "--allow-input") {
      allowInput = true;
    } else if (flag === "--max-dimension") {
      const parsed = value !== undefined ? positiveInt(value, "--max-dimension") : "--max-dimension expects a value";
      if (typeof parsed === "string") return { kind: "invalid", reason: parsed };
      maxDimension = parsed;
      i++;
    } else if (flag === "--click-x" || flag === "--click-y") {
      const parsed =
        value !== undefined && /^\d+(\.\d+)?$/.test(value)
          ? Number(value)
          : `${flag} expects non-negative finite coordinates, got: ${value}`;
      if (typeof parsed === "string") return { kind: "invalid", reason: parsed };
      if (flag === "--click-x") clickX = parsed;
      else clickY = parsed;
      i++;
    } else {
      return { kind: "invalid", reason: `unknown flag: ${flag}` };
    }
  }

  const hasTarget = pid !== undefined || window !== undefined;
  if (!hasTarget && !allowInput) return { kind: "no-target" };
  if (!hasTarget) {
    return { kind: "invalid", reason: "--allow-input requires an explicit --pid and --window target" };
  }
  if (pid === undefined || window === undefined) {
    return { kind: "invalid", reason: "--pid and --window must be provided together" };
  }
  if ((clickX !== undefined || clickY !== undefined) && !allowInput) {
    return { kind: "invalid", reason: "--click-x/--click-y are input and require --allow-input" };
  }
  if (clickX === undefined && clickY === undefined) {
    return { kind: "target", pid, windowId: window, inputAuthorized: allowInput, maxDimension };
  }
  if (clickX === undefined || clickY === undefined) {
    return { kind: "invalid", reason: "--click-x and --click-y must be provided together" };
  }
  return {
    kind: "target",
    pid,
    windowId: window,
    inputAuthorized: allowInput,
    maxDimension,
    click: { x: clickX, y: clickY }
  };
}

// Structural view of the SDK WindowStateOutput the probe reads. Type-only
// shape mirroring keeps this file free of SDK imports on every code path.
interface WindowStateLike {
  pid?: number;
  windowId?: bigint;
  snapshotId?: string;
  windowTitle?: string;
  // Present on the SDK output, deliberately NOT projected (content):
  treeMarkdown?: string;
  elements?: unknown[];
  images?: unknown[];
  screenshotWidth?: number;
  screenshotHeight?: number;
  screenshotScale?: number;
  screenshotMimeType?: string;
  screenshotFrameValid?: boolean;
  windowBounds?: { x: number; y: number; width: number; height: number };
  elementsComplete?: boolean;
  degraded?: boolean;
  degradedReason?: string;
  truncated?: boolean;
  truncationReason?: string;
  totalElementCount?: bigint;
  returnedElementCount?: bigint;
  filteredElementCount?: bigint;
}

export interface ProbeReport {
  mode: string;
  driverStarted: boolean;
  target?: { pid: number; windowId: string };
  inputAuthorized?: boolean;
  observation?: {
    snapshotId?: string;
    windowTitle?: string;
    screenshot?: {
      width?: number;
      height?: number;
      scale?: number;
      mimeType?: string;
      frameValid?: boolean;
    };
    windowBounds?: { x: number; y: number; width: number; height: number };
    ax: {
      complete?: boolean;
      total?: number;
      returned?: number;
      degraded?: boolean;
      degradedReason?: string;
      truncated?: boolean;
      truncationReason?: string;
    };
  };
  backgroundClick?: { status: string; detail?: unknown };
  driverError?: { raw: string };
}

// Allowlist projection: geometry, scale, pixel size, frame validity, AX
// completeness counters. Elements, labels, values, markdown, and image bytes
// are dropped — the report must never carry application content or secrets.
export function projectWindowState(state: WindowStateLike): NonNullable<ProbeReport["observation"]> {
  return {
    snapshotId: state.snapshotId,
    windowTitle: state.windowTitle,
    screenshot: {
      width: state.screenshotWidth,
      height: state.screenshotHeight,
      scale: state.screenshotScale,
      mimeType: state.screenshotMimeType,
      frameValid: state.screenshotFrameValid
    },
    windowBounds: state.windowBounds,
    ax: {
      complete: state.elementsComplete,
      total: state.totalElementCount === undefined ? undefined : Number(state.totalElementCount),
      returned: state.returnedElementCount === undefined ? undefined : Number(state.returnedElementCount),
      degraded: state.degraded,
      degradedReason: state.degradedReason,
      truncated: state.truncated,
      truncationReason: state.truncationReason
    }
  };
}

function emit(report: ProbeReport): void {
  console.log(JSON.stringify(report));
}

function usage(): string {
  return [
    "guarded native capability probe (agentic desktop plan Task A1)",
    "  no flags                      no-target report; the driver is never started",
    "  --pid P --window W            explicit window target (both required together)",
    "  --allow-input                 authorize input delivery (otherwise read-only)",
    "  --click-x X --click-y Y       background window-target coordinate click probe",
    "                                (requires --allow-input; never retried foreground)",
    "  --max-dimension N             request a scaled screenshot from the driver",
    "  --help                        this text"
  ].join("\n");
}

// The SDK import lives here and is only reachable through runTarget(), so
// help/no-target/invalid paths can never load native code. Dev-mode probes
// resolve the SDK from the workspace checkout beside this script.
async function loadSdk(): Promise<any> {
  const { pathToFileURL } = await import("node:url");
  const url = new URL("../../packages/computer-runtime/node_modules/@trycua/cua-driver/dist/index.js", import.meta.url);
  return import(/* @vite-ignore */ pathToFileURL(url.pathname).href);
}

async function runTarget(
  pid: number,
  windowId: bigint,
  allowInput: boolean,
  maxDimension: number | undefined,
  click: { x: number; y: number } | undefined
): Promise<void> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    emit({
      mode: "target",
      driverStarted: false,
      driverError: {
        raw: `unsupported platform for native probe: ${process.platform} ${process.arch}`
      }
    });
    process.exitCode = 5;
    return;
  }
  const sdk = await loadSdk();
  const driver = sdk.CuaDriver.create(undefined);
  const report: ProbeReport = {
    mode: "target",
    driverStarted: true,
    target: { pid, windowId: windowId.toString() },
    inputAuthorized: allowInput
  };
  try {
    const state = await driver.getWindowState(
      sdk.GetWindowStateInput.new({
        pid,
        windowId,
        includeAccessibilityTree: true,
        includeScreenshot: true,
        ...(maxDimension !== undefined ? { maxDimension } : {})
      })
    );
    report.observation = projectWindowState(state);
    if (click) {
      try {
        // Confirmed binding shape (static evidence only until a real window
        // is authorized): Coordinates + Window target + Background delivery.
        const input = sdk.ClickInput.new({
          target: new sdk.ActionTarget.Window({ pid, windowId }),
          position: new sdk.ClickPosition.Coordinates({ x: click.x, y: click.y }),
          deliveryMode: sdk.InputDeliveryMode.Background,
          button: sdk.ClickButton.Left,
          count: 1
        });
        const result = await driver.click(input);
        report.backgroundClick = { status: "returned", detail: result };
      } catch (error) {
        // Raw driver refusal recorded; no foreground retry, ever.
        report.backgroundClick = {
          status: "driver-refused",
          detail: error instanceof Error ? `${error}` : String(error)
        };
      }
    }
  } catch (error) {
    report.driverError = { raw: error instanceof Error ? `${error}` : String(error) };
    process.exitCode = 5;
  } finally {
    try {
      await driver.shutdown();
    } catch {
      // best effort; uniffiDestroy below still releases the handle
    }
    try {
      driver.uniffiDestroy?.();
    } catch {
      // ignore
    }
  }
  emit(report);
}

async function main(): Promise<void> {
  const request = parseProbeArgs(process.argv.slice(2));
  if (request.kind === "usage") {
    console.log(usage());
    return;
  }
  if (request.kind === "invalid") {
    emit({ mode: "invalid", driverStarted: false, driverError: { raw: request.reason } });
    process.exitCode = 2;
    return;
  }
  if (request.kind === "no-target") {
    emit({ mode: "no-target", driverStarted: false });
    return;
  }
  await runTarget(request.pid, request.windowId, request.inputAuthorized, request.maxDimension, request.click);
}

// Never let a probe invocation sit on an accidental native hang: a hard
// ceiling reaps this process even if the driver blocks.
const HARD_CEILING_MS = 60_000;
setTimeout(() => {
  console.error(`probe hard ceiling exceeded (${HARD_CEILING_MS}ms); exiting`);
  process.exit(6);
}, HARD_CEILING_MS).unref?.();

void main();
