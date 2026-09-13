import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";

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
  // Runs for real only where package:release has produced dist/release
  // (release runners order packaging before tests; other machines skip).
  const outDir = resolve("dist/release/ya-skills");
  const ready = existsSync(join(outDir, "yk"));
  const runnable = ready && process.platform === "darwin" && process.arch === "arm64";
  const maybe = runnable ? test : test.skip;

  maybe("assembles the sidecar runtime with every required file and no symlinks", async () => {
    const runtime = join(outDir, "runtime", "computer-use", "node_modules");

    expect(await exists(join(outDir, "yk"))).toBe(true);
    for (const rel of REQUIRED_RUNTIME_FILES) {
      expect(await exists(join(runtime, rel))).toBe(true);
    }
    const symlinks = await collectSymlinks(runtime);
    expect(symlinks).toEqual([]);
  });

  // Pure-load variant: `list` reads only the catalog — no desktop, no
  // native driver init. The desktop-touching `apps` variant lives in
  // tests/computer-use-native.test.ts behind YK_CU_NATIVE_TESTS=1.
  test.skipIf(!runnable)(
    "compiled yk loads from a hostile package.json cwd without executing project scripts",
    async () => {
      const exe = join(outDir, "yk");
      const hostile = await mkdtemp(join(tmpdir(), "cu-hostile-"));
      await writeFile(
        join(hostile, "package.json"),
        JSON.stringify({
          name: "hostile",
          version: "1.0.0",
          scripts: { preinstall: "touch SENTINEL_RAN", prepare: "touch SENTINEL_RAN" },
          dependencies: { "@trycua/cua-driver": "0.0.0-fake" }
        })
      );
      const run = (args: string[]) =>
        Bun.spawn([exe, ...args], {
          cwd: hostile,
          env: { ...Bun.env, NODE_PATH: "", YA_SKILLS_CATALOG_DIR: join(outDir, "skills") },
          stdout: "pipe",
          stderr: "pipe"
        });
      // list AND computer-use --help: with a fake @trycua dependency in
      // package.json, any SDK import on these paths would fail to resolve —
      // this is the compiled-level laziness proof.
      const help = run(["computer-use", "--help"]);
      const [helpOut, , helpCode] = await Promise.all([
        new Response(help.stdout).text(),
        new Response(help.stderr).text(),
        help.exited
      ]);
      expect(helpCode).toBe(0);
      expect(helpOut).toContain("perceive");
      const proc = run(["list"]);
      const [stdout, , exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("computer-use");
      expect(await exists(join(hostile, "SENTINEL_RAN"))).toBe(false);
      await rm(hostile, { recursive: true, force: true });
    }
  );

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
