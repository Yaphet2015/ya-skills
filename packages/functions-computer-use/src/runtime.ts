// Doctor: read-only health report over a shared session. The command-level
// deadline and the real session factory come from @ya-skills/computer-runtime.

import {
  ComputerError,
  createComputerSession,
  isCompiledRuntime,
  isSupportedPlatform,
  type ComputerSession
} from "@ya-skills/computer-runtime";

export { compiledSdkUrl, isCompiledRuntime, isSupportedPlatform, loadSdk } from "@ya-skills/computer-runtime";

export { COMMAND_DEADLINE_MS, CLEANUP_DEADLINE_MS } from "./consts.js";

export interface DoctorReport {
  ok: boolean;
  platform: string;
  arch: string;
  sdk: { loaded: boolean; version?: string; error?: string };
  driver: { created?: boolean; sameProcess?: boolean; error?: string };
  permissions: { accessibility: boolean | "unknown"; screenRecording: boolean | "unknown" };
  hints: string[];
}

export interface PlatformInfo {
  platform: string;
  arch: string;
}

export interface DoctorDeps {
  platformInfo?: PlatformInfo;
  createSession?: () => ComputerSession;
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

  const session = (deps.createSession ?? createComputerSession)();
  try {
    const meta = await session.metadata();
    report.sdk.loaded = true;
    report.sdk.version = meta.driverVersion;
    report.driver.created = true;
    report.driver.sameProcess = meta.pid === process.pid;
    if (report.driver.sameProcess === false) {
      report.hints.push("driver reported a different pid — same-process assumption broken");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report.sdk.error = message;
    const fromCompiledLoader =
      isCompiledRuntime() || /file:\/\/|runtime\/computer-use/.test(message);
    report.hints.push(
      fromCompiledLoader
        ? "runtime files missing beside the yk executable — reinstall ya-skills"
        : `driver failed: ${message}`
    );
  }

  try {
    report.permissions = await session.permissions();
  } catch {
    // stays unknown
  }
  if (report.permissions.accessibility !== true || report.permissions.screenRecording !== true) {
    report.hints.push(
      "grant Accessibility AND Screen Recording to the program running yk (" +
        `${process.execPath}) and your terminal, then restart the terminal; doctor never opens dialogs itself`
    );
  }

  try {
    await session.close();
  } catch (error) {
    const message = error instanceof ComputerError ? error.message : String(error);
    report.hints.push(`driver cleanup issues: ${message}`);
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
