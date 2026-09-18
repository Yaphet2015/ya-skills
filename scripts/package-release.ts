#!/usr/bin/env bun
// Single packaging entrypoint for release assets. Assembles:
//   dist/release/ya-skills/yk                          (compiled binary)
//   dist/release/ya-skills/skills/                     (skill catalog)
//   dist/release/ya-skills/runtime/computer-use/...    (SDK + native sidecar)
// and produces ya-skills-v<version>-macos-arm64.tar.gz + .sha256 in cwd.
// Both release workflows call this script; never hand-assemble the layout.

import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import packageJson from "../package.json" with { type: "json" };

const PINNED: Record<string, string> = {
  "@trycua/cua-driver": "0.27.0",
  "@trycua/cua-driver-darwin-arm64": "0.27.0",
  "@ubjs/core": "0.31.0-3",
  "@ubjs/node": "0.31.0-3"
};

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  if (i === -1 || !process.argv[i + 1]) {
    console.error(`missing ${name} <value>`);
    process.exit(2);
  }
  return process.argv[i + 1]!;
}

const version = arg("--version");
if (version !== packageJson.version) {
  // A stale checkout must never ship assets whose name/binary disagree.
  console.error(`--version ${version} != package.json ${packageJson.version} — rebase and retry`);
  process.exit(1);
}

const root = resolve(import.meta.dir, "..");
const outRoot = join(root, "dist", "release", "ya-skills");
const runtimeDir = join(outRoot, "runtime", "computer-use", "node_modules");

function sh(label: string, cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`${label} failed with exit ${r.status}`);
    process.exit(1);
  }
}

// 0. Regenerate installed API declarations from source so packaged Skills
// cannot drift from the runtime contracts.
sh("generate computer-use api types", "bun", ["scripts/generate-computer-use-api.ts"]);
sh("generate e2e api types", "bun", ["scripts/generate-computer-e2e-api.ts"]);

// 1. Compile yk with the pinned flags (kept in sync with package.json).
sh(
  "build yk",
  "bun",
  "build --compile --target=bun-macos-arm64 --compile-autoload-package-json --define YA_SKILLS_COMPILED=true --external @trycua/cua-driver --outfile=dist/yk packages/cli/src/cli.ts".split(" ")
);

// 2. Assemble the release directory.
// Sign the finished executable so the signature covers the compiled payload.
sh("sign yk", "codesign", ["--force", "--sign", "-", join(root, "dist", "yk")]);
sh("verify yk signature", "codesign", ["--verify", "--strict", join(root, "dist", "yk")]);

rmSync(outRoot, { recursive: true, force: true });
mkdirSync(runtimeDir, { recursive: true });
cpSync(join(root, "dist", "yk"), join(outRoot, "yk"));
cpSync(join(root, "skills"), join(outRoot, "skills"), { recursive: true });

// 3. Copy the four locked runtime packages from the installed tree.
// @ubjs/* are transitive deps of @trycua/cua-driver, so resolve them from
// the cua-driver package (bun keeps them in node_modules/.bun).
const pkgRequire = createRequire(join(root, "packages", "computer-runtime", "package.json"));
const cuaPath = pkgRequire.resolve("@trycua/cua-driver/package.json");
const cuaRequire = createRequire(cuaPath);
const resolvePkg = (name: string): string =>
  name.startsWith("@ubjs/") ? cuaRequire.resolve(`${name}/package.json`) : pkgRequire.resolve(`${name}/package.json`);
for (const name of Object.keys(PINNED)) {
  const pkgJsonPath = resolvePkg(name);
  const installed = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
    name: string;
    version: string;
  };
  if (installed.version !== PINNED[name]) {
    console.error(`pinned ${name}@${PINNED[name]} but installed ${installed.version} — update the PINNED map`);
    process.exit(1);
  }
  const srcDir = dirname(pkgJsonPath);
  const destDir = join(runtimeDir, ...name.split("/"));
  cpSync(srcDir, destDir, { recursive: true, verbatimSymlinks: false, dereference: true });
}

// 4. Assert the layout the compiled loader needs; fail loudly on any gap.
const REQUIRED = [
  "@trycua/cua-driver/dist/index.js",
  "@trycua/cua-driver-darwin-arm64/libcua_driver_sdk.dylib",
  "@trycua/cua-driver-darwin-arm64/cua_driver_node_runtime.node",
  "@ubjs/core/package.json",
  "@ubjs/node/typescript/dist/resolve-lib.js"
];
for (const rel of REQUIRED) {
  const p = join(runtimeDir, rel);
  if (!existsSync(p) || !statSync(p).isFile()) {
    console.error(`missing required runtime file: ${rel}`);
    process.exit(1);
  }
}
const REQUIRED_SKILLS = [
  join(outRoot, "skills", "computer-use", "SKILL.md"),
  join(outRoot, "skills", "computer-use", "skill.json"),
  join(outRoot, "skills", "computer-use", "references", "api.d.ts"),
  join(outRoot, "skills", "computer-use", "examples", "search.js"),
  join(outRoot, "skills", "computer-e2e", "SKILL.md"),
  join(outRoot, "skills", "computer-e2e", "skill.json"),
  join(outRoot, "skills", "computer-e2e", "references", "api.d.ts"),
  join(outRoot, "skills", "computer-e2e", "examples", "pure.e2e.ts")
];
for (const mustExist of [join(outRoot, "yk"), ...REQUIRED_SKILLS]) {
  if (!existsSync(mustExist)) {
    console.error(`missing release file: ${mustExist}`);
    process.exit(1);
  }
}

// 5. Tarball + checksum (outputs land in cwd, matching the workflows).
const asset = `ya-skills-v${version}-macos-arm64.tar.gz`;
sh("tar", "tar", ["-czf", asset, "-C", outRoot, "yk", "skills", "runtime"]);
const sha = spawnSync("shasum", ["-a", "256", asset], { encoding: "utf8" });
if (sha.status !== 0) {
  console.error("shasum failed");
  process.exit(1);
}
writeFileSync(`${asset}.sha256`, sha.stdout);
console.log(`packaged ${asset} from ${outRoot}`);
