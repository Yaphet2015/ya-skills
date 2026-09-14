// The ONLY module in this package that touches the Cua SDK. Compiled mode
// locates the SDK beside the realpath'd executable — never from cwd,
// NODE_PATH, or a dev checkout.

import { realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export interface PlatformInfo {
  platform: string;
  arch: string;
}

export function isSupportedPlatform(info: PlatformInfo): true | string {
  if (info.platform === "darwin" && info.arch === "arm64") return true;
  return `computer runtime requires macOS arm64 (this machine: ${info.platform} ${info.arch}). ` +
    "Other platforms are not shipped yet.";
}

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

// --define YA_SKILLS_COMPILED=true replaces the identifier at compile time
// (literal `true`); in dev/test runs the bare identifier throws -> false.
declare const YA_SKILLS_COMPILED: boolean | undefined;

export function isCompiledRuntime(): boolean {
  try {
    return YA_SKILLS_COMPILED === true;
  } catch {
    return false;
  }
}

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
