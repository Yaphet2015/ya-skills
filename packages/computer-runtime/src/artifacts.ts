// Evidence artifacts: user cache by default, explicit override, unique names,
// private permissions. Never the install dir or the project.

import { chmodSync, copyFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { NativeObservationLike } from "./types.js";
import { ComputerError } from "./driver-result.js";

export function defaultArtifactsDir(): string {
  return join(homedir(), "Library", "Caches", "ya-skills", "computer-use");
}

export function ensureOutDir(explicit?: string): string {
  // Reported paths are always absolute, whatever the caller passed.
  const dir = explicit === undefined ? defaultArtifactsDir() : isAbsolute(explicit) ? explicit : resolve(explicit);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function artifactPath(dir: string, name: string): string {
  return join(dir, `${Date.now()}-${randomBytes(4).toString("hex")}-${name}`);
}

/** Enforce the screenshot privacy contract even when a path already exists.
 * writeFile({ mode }) only applies at creation time, and copy/sips preserve
 * or choose their own mode; chmod followed by stat is therefore required. */
export function ensurePrivateFile(file: string): void {
  const before = statSync(file);
  if (!before.isFile()) {
    throw new Error(`screenshot artifact is not a regular file: ${file}`);
  }
  chmodSync(file, 0o600);
  const after = statSync(file);
  if (!after.isFile()) {
    throw new Error(`screenshot artifact is not a regular file: ${file}`);
  }
  const mode = after.mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(`screenshot artifact is not private: ${file} has mode ${mode.toString(8)}`);
  }
}

// Screenshots are secrets-by-default: written once, user-only (0600).
export function saveScreenshot(dir: string, base64: string): string {
  if (typeof base64 !== "string" || base64.trim() === "") {
    throw new Error("screenshot data is empty");
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64.trim())) {
    throw new Error("screenshot data is not valid base64");
  }
  let data: Buffer;
  try {
    data = Buffer.from(base64, "base64");
  } catch (error) {
    throw new Error(`screenshot data is not valid base64: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (data.length === 0) throw new Error("screenshot data decoded to an empty file");
  const file = artifactPath(dir, "cu.png");
  writeFileSync(file, data, { mode: 0o600 });
  ensurePrivateFile(file);
  return file;
}

export function persistObservationImage(raw: NativeObservationLike, artifactsDir?: string): string | undefined {
  const base64 = raw.images?.[0]?.dataBase64;
  try {
    if (typeof base64 === "string" && base64.length > 0) {
      return saveScreenshot(ensureOutDir(artifactsDir), base64);
    }
    const source = raw.screenshotFilePath;
    if (typeof source === "string" && source.length > 0) {
      const stats = statSync(source);
      if (!stats.isFile() || stats.size <= 0) throw new Error(`screenshot file is empty or not a regular file: ${source}`);
      const destination = artifactPath(ensureOutDir(artifactsDir), "cu.png");
      copyFileSync(source, destination);
      // copyFileSync does not honor a mode argument and may inherit a
      // permissive source mode. Enforce the artifact contract on the actual
      // destination and let chmod/stat failures escape loudly.
      ensurePrivateFile(destination);
      return destination;
    }
    return undefined;
  } catch (error) {
    // Fail loud: the screenshot bytes exist but the evidence artifact does
    // not. A "usable" image channel without a persisted file would be a
    // fabricated success (A2/A3 fail-loud contract).
    throw new ComputerError(
      "artifact_write_failed",
      `the screenshot could not be persisted: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
