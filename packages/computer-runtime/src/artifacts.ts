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
  const file = artifactPath(dir, "cu.png");
  writeFileSync(file, Buffer.from(base64, "base64"), { mode: 0o600 });
  return file;
}
