#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";

interface LinkState {
  link: string;
  previousTarget: string | null;
  versions: string[];
}

export function selectLinkPath(npmPrefix: string, searchPath: string, explicitPrefix?: string): string {
  if (explicitPrefix) return join(resolve(explicitPrefix), "bin/yk");
  // npm prepends project executables; those are not the user's global command.
  const globalPath = searchPath.split(delimiter)
    .filter((entry) => !resolve(entry).endsWith("/node_modules/.bin"))
    .join(delimiter);
  return Bun.which("yk", { PATH: globalPath }) ?? join(resolve(npmPrefix), "bin/yk");
}

function readLink(path: string): string | null {
  try {
    if (!lstatSync(path).isSymbolicLink()) {
      throw new Error(`${path} is not a symlink; leave it in place and choose another npm global prefix.`);
    }
    return readlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function replaceLink(path: string, target: string): void {
  const temporary = `${path}.ya-skills-${crypto.randomUUID()}`;
  try {
    symlinkSync(target, temporary);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function statePath(root: string): string {
  return join(root, "dist/local/state.json");
}

function loadState(root: string): LinkState | null {
  const path = statePath(root);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as LinkState : null;
}

function buildPackage(root: string, version: string): void {
  const result = spawnSync("bun", ["run", "package:release", "--version", version], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`package:release failed (${result.status}); the global link was not changed.`);
}

export function linkLocal(root: string, linkPath: string, build = buildPackage): void {
  root = resolve(root);
  const link = resolve(linkPath);
  const launcher = join(root, "dist/local/yk");
  let previous = loadState(root);
  if (previous && previous.link !== link) {
    cleanLocal(root);
    previous = null;
  }
  const current = readLink(link);
  const isOurs = current !== null && resolve(dirname(link), current) === launcher;
  if (previous && current !== null && !isOurs && current !== previous.previousTarget) {
    throw new Error(`${link} changed since dev:link; run dev:clean before linking again.`);
  }
  if (!previous && isOurs) throw new Error(`Missing ${statePath(root)}; cannot recover the original link.`);
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
  const state: LinkState = previous ?? { link, previousTarget: current, versions: [] };
  state.versions = [...new Set([...state.versions, version])];
  mkdirSync(dirname(statePath(root)), { recursive: true });
  // Save before building so dev:clean can also remove a partial failed build.
  writeFileSync(statePath(root), JSON.stringify(state, null, 2) + "\n");
  build(root, version);
  const packaged = join(root, "dist/release/ya-skills");
  if (!existsSync(join(packaged, "yk")) || !existsSync(join(packaged, "skills"))) {
    throw new Error("package:release did not produce yk and skills; the global link was not changed.");
  }
  writeFileSync(launcher, [
    "#!/bin/sh",
    'if [ -z "${YA_SKILLS_CATALOG_DIR:-}" ]; then',
    `  export YA_SKILLS_CATALOG_DIR=${shellQuote(join(packaged, "skills"))}`,
    "fi",
    `exec ${shellQuote(join(packaged, "yk"))} "$@"`,
    "",
  ].join("\n"));
  chmodSync(launcher, 0o755);
  mkdirSync(dirname(link), { recursive: true });
  if (readLink(link) !== current) throw new Error(`${link} changed while building; leave it untouched.`);
  replaceLink(link, launcher);
  console.log(`Linked ${link} -> ${launcher}\nRun yk list to check the local catalog. Restore with npm run dev:clean.`);
}

export function cleanLocal(root: string): void {
  root = resolve(root);
  const state = loadState(root);
  if (!state) {
    console.log("No local link or recorded build to clean.");
    return;
  }
  const launcher = join(root, "dist/local/yk");
  // A newer installation owns an unrelated link/file; never remove or replace it.
  let target: string | null = null;
  try {
    if (lstatSync(state.link).isSymbolicLink()) target = readlinkSync(state.link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (target !== null && resolve(dirname(state.link), target) === launcher) {
    if (state.previousTarget === null) rmSync(state.link);
    else replaceLink(state.link, state.previousTarget);
  }
  rmSync(join(root, "dist/yk"), { force: true });
  rmSync(join(root, "dist/release/ya-skills"), { recursive: true, force: true });
  for (const version of state.versions) {
    const archive = join(root, `ya-skills-v${version}-macos-arm64.tar.gz`);
    rmSync(archive, { force: true });
    rmSync(`${archive}.sha256`, { force: true });
  }
  rmSync(join(root, "dist/local"), { recursive: true, force: true });
  console.log("Removed the local build and restored the previous yk link when still owned by this checkout.");
}

if (import.meta.main) {
  try {
    const root = resolve(import.meta.dir, "..");
    if (process.argv[2] === "clean") {
      cleanLocal(root);
    } else if (process.argv[2] === "link") {
      const result = spawnSync("npm", ["prefix", "-g"], { encoding: "utf8" });
      if (result.error) throw result.error;
      if (result.status !== 0 || !result.stdout.trim()) throw new Error(result.stderr || "Cannot resolve npm global prefix.");
      const args = process.argv.slice(3);
      if (args.length !== 0 && (args.length !== 2 || args[0] !== "--prefix")) {
        throw new Error("Usage: npm run dev:link -- [--prefix /absolute/prefix]");
      }
      const link = selectLinkPath(result.stdout.trim(), process.env.PATH ?? "", args[1]);
      linkLocal(root, link);
    } else {
      throw new Error("Usage: bun scripts/local-link.ts link|clean");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
