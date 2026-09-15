// Evidence artifacts: user cache by default, explicit override, unique names,
// private permissions. Never the install dir or the project.

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

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
  return file;
}
