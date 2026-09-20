import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { JsonObject } from "./adapters/types.js";
import { absolutePath } from "./workspace.js";

export function execGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function execGitRaw(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function execGitDir(gitDir: string, args: string[]): string {
  return execGitRaw(process.cwd(), ["--git-dir", gitDir, ...args]).trim();
}

export function resolveGitRoot(cwdInput: string): string {
  try {
    return execGit(absolutePath(cwdInput), ["rev-parse", "--show-toplevel"]);
  } catch {
    throw new Error(`Subject root must be inside a Git repository: ${cwdInput}`);
  }
}

export function getHeadCommit(repoRoot: string): string {
  return execGit(repoRoot, ["rev-parse", "HEAD"]);
}

export function getBranch(repoRoot: string): string | null {
  try {
    return execGit(repoRoot, ["branch", "--show-current"]) || null;
  } catch {
    return null;
  }
}

export function getOrigin(repoRoot: string): string | null {
  try {
    return execGit(repoRoot, ["remote", "get-url", "origin"]) || null;
  } catch {
    return null;
  }
}

function canonicalRepoIdentity(repoRoot: string): string {
  const origin = getOrigin(repoRoot);
  return origin ? origin.trim().replace(/\.git$/, "").toLowerCase() : resolve(repoRoot);
}

function repoIdFor(repoRoot: string): string {
  const hash = createHash("sha256").update(canonicalRepoIdentity(repoRoot)).digest("hex").slice(0, 12);
  return `repo_${hash}`;
}

export function syncRepoCache(
  workspaceRoot: string,
  sourceRepoRoot: string,
  commit: string,
  caseId: string
): { repoId: string; repoCachePath: string; ref: string } {
  const repoId = repoIdFor(sourceRepoRoot);
  const repoCachePath = join(workspaceRoot, "repos", `${repoId}.git`);
  if (!existsSync(repoCachePath)) {
    execFileSync("git", ["clone", "--bare", sourceRepoRoot, repoCachePath], { stdio: ["ignore", "pipe", "pipe"] });
  }
  try {
    execGitDir(repoCachePath, ["cat-file", "-e", `${commit}^{commit}`]);
  } catch {
    execGitDir(repoCachePath, ["fetch", sourceRepoRoot, commit]);
  }
  const ref = `refs/personal-bench/cases/${caseId}/baseline`;
  execGitDir(repoCachePath, ["update-ref", ref, commit]);
  return { repoId, repoCachePath, ref };
}

export function detectSetupCommands(repoRoot: string): JsonObject[] {
  if (!existsSync(join(repoRoot, "package.json"))) return [];
  const managers = [
    ["bun.lock", "bun install --frozen-lockfile"],
    ["bun.lockb", "bun install --frozen-lockfile"],
    ["pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
    ["package-lock.json", "npm ci"],
    ["yarn.lock", "yarn install --frozen-lockfile"]
  ] as const;
  const match = managers.find(([lockfile]) => existsSync(join(repoRoot, lockfile)));
  return match ? [{ command: match[1], cwd: ".", timeoutSeconds: 300 }] : [];
}
