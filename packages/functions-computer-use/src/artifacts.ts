// Evidence artifacts: user cache by default, explicit --out-dir override,
// unique names, private permissions. Never the install dir or the project.

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export function defaultArtifactsDir(): string {
  return join(homedir(), "Library", "Caches", "ya-skills", "computer-use");
}

export function ensureOutDir(explicit?: string): string {
  const dir = explicit ?? defaultArtifactsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function artifactPath(dir: string, name: string): string {
  return join(dir, `${Date.now()}-${randomBytes(4).toString("hex")}-${name}`);
}
