// Driver lifecycle: lazy single import, bounded deadlines, ordered cleanup.
// The SDK is imported ONLY when a computer-use action actually runs — help,
// list, install, and invalid input paths must never touch native code.

import { realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const COMMAND_DEADLINE_MS = 30_000;
export const CLEANUP_DEADLINE_MS = 5_000;

export interface PlatformInfo {
  platform: string;
  arch: string;
}

export function isSupportedPlatform(info: PlatformInfo): true | string {
  if (info.platform === "darwin" && info.arch === "arm64") return true;
  return `computer-use requires macOS arm64 (this machine: ${info.platform} ${info.arch}). ` +
    "Other platforms are not shipped yet; see docs/computer-use.md.";
}

// Compiled mode locates the SDK beside the REAL executable (Homebrew bin/opt/
// Cellar symlinks resolved), never from cwd or the development checkout.
export function compiledSdkUrl(execPath: string): string {
  const real = realpathSync(execPath);
  if (!statSync(real).isFile()) {
    throw new Error(`not an executable file: ${execPath}`);
  }
  return pathToFileURL(
    join(
      dirname(real),
      "runtime",
      "computer-use",
      "node_modules",
      "@trycua",
      "cua-driver",
      "dist",
      "index.js"
    )
  ).href;
}

type MinimalDriver = {
  endSession(input: never): Promise<unknown>;
  shutdown(): Promise<unknown>;
  uniffiDestroy?(): void;
};

export interface DriverHarness {
  work: (driver: MinimalDriver) => Promise<string>;
  load: () => Promise<{ CuaDriver: { create(options: unknown): unknown } }>;
  create: () => Promise<MinimalDriver>;
  deadlineMs?: number;
  cleanupDeadlineMs?: number;
}

function withDeadline<T>(label: string, promise: Promise<T>, deadlineMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${deadlineMs}ms`));
    }, deadlineMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function cleanup(driver: MinimalDriver, errors: Error[], deadlineMs: number): Promise<void> {
  // One shared budget across all steps (spec: cleanup gets at most 5s total).
  const deadline = Date.now() + deadlineMs;
  const remaining = () => Math.max(deadline - Date.now(), 1);
  // Every step runs even if the previous one failed; nothing masks the primary.
  try {
    await withDeadline("endSession", Promise.resolve(driver.endSession({} as never)), remaining());
  } catch (e) {
    errors.push(e instanceof Error ? e : new Error(String(e)));
  }
  try {
    await withDeadline("shutdown", Promise.resolve(driver.shutdown()), remaining());
  } catch (e) {
    errors.push(e instanceof Error ? e : new Error(String(e)));
  }
  try {
    driver.uniffiDestroy?.();
  } catch (e) {
    errors.push(e instanceof Error ? e : new Error(String(e)));
  }
}

export async function withDriver(harness: DriverHarness): Promise<string> {
  const deadlineMs = harness.deadlineMs ?? COMMAND_DEADLINE_MS;
  const cleanupDeadlineMs = harness.cleanupDeadlineMs ?? CLEANUP_DEADLINE_MS;
  // The SAME deadline covers load/create/work: a hanging dylib load or driver
  // create must not pin the CLI forever either.
  const sdk = await withDeadline("sdk load", harness.load(), deadlineMs);
  const driver = (await withDeadline("driver create", harness.create(), deadlineMs)) as MinimalDriver;
  const cleanupErrors: Error[] = [];
  let result: string;
  try {
    result = await withDeadline("command", harness.work(driver), deadlineMs);
  } catch (error) {
    await cleanup(driver, cleanupErrors, cleanupDeadlineMs);
    if (cleanupErrors.length > 0) {
      console.error("driver cleanup issues (primary error kept):", cleanupErrors);
    }
    throw error;
  }
  await cleanup(driver, cleanupErrors, cleanupDeadlineMs);
  if (cleanupErrors.length > 0) {
    // The action itself completed; cleanup problems surface loudly on stderr
    // without rewriting a successful result into a failure.
    console.error("driver cleanup issues:", cleanupErrors);
  }
  return result;
}

// Real loaders ----------------------------------------------------------------

let sdkPromise: Promise<typeof import("@trycua/cua-driver")> | null = null;

export function loadSdk(): Promise<typeof import("@trycua/cua-driver")> {
  const platform = isSupportedPlatform(process);
  if (platform !== true) {
    throw new Error(platform);
  }
  if (isCompiledRuntime()) {
    return import(/* @vite-ignore */ compiledSdkUrl(process.execPath));
  }
  sdkPromise ??= import("@trycua/cua-driver");
  return sdkPromise;
}

// --define YA_SKILLS_COMPILED=true replaces the identifier at compile time
// (literal `true`); in dev/test runs the bare identifier throws → false.
declare const YA_SKILLS_COMPILED: boolean | undefined;

export function isCompiledRuntime(): boolean {
  try {
    return YA_SKILLS_COMPILED === true;
  } catch {
    return false;
  }
}

// doctor ----------------------------------------------------------------------

export interface DoctorReport {
  ok: boolean;
  platform: string;
  arch: string;
  sdk: { loaded: boolean; version?: string; error?: string };
  driver: { created?: boolean; sameProcess?: boolean; error?: string };
  permissions: { accessibility: boolean | "unknown"; screenRecording: boolean | "unknown" };
  hints: string[];
}

export interface DoctorDeps {
  platformInfo?: PlatformInfo;
  load?: () => Promise<{ CuaDriver: { create(options: unknown): unknown } } & Record<string, unknown>>;
  create?: () => Promise<MinimalDriver & { metadata(): Promise<{ driverVersion?: string; pid?: number }> }>;
  execPath?: string;
}

export async function runDoctor(deps: DoctorDeps = {}): Promise<DoctorReport> {
  const info = deps.platformInfo ?? { platform: process.platform, arch: process.arch };
  const report: DoctorReport = {
    ok: false,
    platform: info.platform,
    arch: info.arch,
    sdk: { loaded: false },
    driver: {},
    permissions: { accessibility: "unknown", screenRecording: "unknown" },
    hints: []
  };
  const platformOk = isSupportedPlatform(info);
  if (platformOk !== true) {
    report.sdk.error = String(platformOk);
    report.hints.push(String(platformOk));
    return report;
  }
  const load = deps.load ?? loadSdk;
  let sdk: Awaited<ReturnType<NonNullable<DoctorDeps["load"]>>>;
  try {
    sdk = await load();
  } catch (e) {
    report.sdk.error = e instanceof Error ? e.message : String(e);
    const fromCompiledLoader =
      isCompiledRuntime() || /file:\/\/|runtime\/computer-use/.test(report.sdk.error);
    report.hints.push(
      fromCompiledLoader
        ? "runtime files missing beside the yk executable — reinstall ya-skills"
        : `SDK failed to load: ${report.sdk.error}`
    );
    return report;
  }
  report.sdk.loaded = true;

  const create =
    deps.create ?? (async () => (sdk as { CuaDriver: { create(o: unknown): unknown } }).CuaDriver.create(undefined) as never);
  try {
    const driver = await create();
    report.driver.created = true;
    try {
      const meta = await withDeadline("metadata", driver.metadata(), COMMAND_DEADLINE_MS);
      report.sdk.version = meta.driverVersion;
      report.driver.sameProcess = meta.pid === process.pid;
      if (report.driver.sameProcess === false) {
        report.hints.push("driver reported a different pid — same-process assumption broken");
      }
    } catch (e) {
      report.driver.error = e instanceof Error ? e.message : String(e);
    } finally {
      const cleanupErrors: Error[] = [];
      await cleanup(driver, cleanupErrors, CLEANUP_DEADLINE_MS);
      if (cleanupErrors.length > 0) {
        report.hints.push(`driver cleanup issues: ${cleanupErrors.map((e) => e.message).join("; ")}`);
      }
    }
  } catch (e) {
    report.driver.error = e instanceof Error ? e.message : String(e);
  }

  const status = (sdk as { currentMacOsPermissionStatus?: () => { accessibility: boolean; screenRecording: boolean } })
    .currentMacOsPermissionStatus;
  if (typeof status === "function") {
    try {
      const s = status.call(sdk);
      report.permissions = { accessibility: s.accessibility, screenRecording: s.screenRecording };
      if (!s.accessibility || !s.screenRecording) {
        report.hints.push(
          `grant Accessibility AND Screen Recording to the program running yk (${process.execPath}) and your terminal, then restart the terminal; doctor never opens dialogs itself`
        );
      }
    } catch {
      // stays unknown
    }
  }

  report.ok =
    report.sdk.loaded &&
    report.driver.created === true &&
    report.driver.sameProcess === true &&
    report.driver.error === undefined &&
    report.permissions.accessibility === true &&
    report.permissions.screenRecording === true;
  return report;
}
