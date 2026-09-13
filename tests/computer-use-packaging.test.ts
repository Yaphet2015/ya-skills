import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { readdir, stat } from "node:fs/promises";

// Packaging contract: the release tarball must carry the native runtime the
// compiled yk loads beside its executable — assembled from locked deps by a
// script, never by copying a dev node_modules or the /tmp probe artifacts.

const REQUIRED_RUNTIME_FILES = [
  "@trycua/cua-driver/package.json",
  "@trycua/cua-driver/dist/index.js",
  "@trycua/cua-driver-darwin-arm64/package.json",
  "@trycua/cua-driver-darwin-arm64/libcua_driver_sdk.dylib",
  "@trycua/cua-driver-darwin-arm64/cua_driver_node_runtime.node",
  "@ubjs/core/package.json",
  "@ubjs/node/package.json",
  "@ubjs/node/typescript/dist/resolve-lib.js"
];

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function collectSymlinks(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isSymbolicLink()) found.push(join(entry.parentPath, entry.name));
  }
  return found;
}

describe("package:release runtime assembly", () => {
  test("assembles the sidecar runtime with every required file and no symlinks", async () => {
    const outDir = resolve("dist/release/ya-skills");
    const runtime = join(outDir, "runtime", "computer-use", "node_modules");

    expect(await exists(join(outDir, "yk"))).toBe(true);
    for (const rel of REQUIRED_RUNTIME_FILES) {
      expect(await exists(join(runtime, rel))).toBe(true);
    }
    const symlinks = await collectSymlinks(runtime);
    expect(symlinks).toEqual([]);
  });

  test("compiled yk build uses the pinned external + autoload + define flags", async () => {
    const pkg = (await Bun.file(resolve("package.json")).json()) as { scripts: Record<string, string> };
    const build = pkg.scripts["build:binary:macos-arm64"] ?? "";
    expect(build).toContain("--compile-autoload-package-json");
    expect(build).toContain("--define YA_SKILLS_COMPILED=true");
    expect(build).toContain("--external @trycua/cua-driver");
  });

  test("package:release script is the single packaging entrypoint both workflows call", async () => {
    const pkg = (await Bun.file(resolve("package.json")).json()) as { scripts: Record<string, string> };
    expect(pkg.scripts["package:release"]).toBeDefined();

    for (const workflow of ["release.yml", "release-please.yml"]) {
      const text = await Bun.file(resolve(".github/workflows", workflow)).text();
      expect(text).toContain("package:release");
      expect(text).not.toMatch(/cp -R runtime|tar -czf.*runtime(?!\/)/);
    }
  });
});
