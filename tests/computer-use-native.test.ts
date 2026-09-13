import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";

// Desktop-touching checks for the compiled yk. These READ the real desktop
// (no clicks, no activation) and therefore run ONLY when the operator opts in
// via YK_CU_NATIVE_TESTS=1 — the default suite must stay desktop-free.

const outDir = resolve("dist/release/ya-skills");
const ready = existsSync(join(outDir, "yk"));
const nativeOptIn = process.env.YK_CU_NATIVE_TESTS === "1";
const runnable = ready && nativeOptIn && process.platform === "darwin" && process.arch === "arm64";
const maybe = runnable ? test : test.skip;

describe("compiled yk native (opt-in via YK_CU_NATIVE_TESTS=1)", () => {
  maybe("loads the SDK sidecar in-process from a hostile cwd and reads real apps", async () => {
    const exe = join(outDir, "yk");
    const hostile = await mkdtemp(join(tmpdir(), "cu-native-hostile-"));
    await writeFile(
      join(hostile, "package.json"),
      JSON.stringify({
        name: "hostile",
        version: "1.0.0",
        scripts: { preinstall: "touch SENTINEL_RAN", prepare: "touch SENTINEL_RAN" },
        dependencies: { "@trycua/cua-driver": "0.0.0-fake" }
      })
    );
    const proc = Bun.spawn([exe, "computer-use", "apps", "--name", "Finder"], {
      cwd: hostile,
      env: { ...Bun.env, NODE_PATH: "", YA_SKILLS_CATALOG_DIR: join(outDir, "skills") },
      stdout: "pipe",
      stderr: "pipe"
    });
    const [stdout, , exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Finder");
    expect(await Bun.file(join(hostile, "SENTINEL_RAN")).exists()).toBe(false);
    await rm(hostile, { recursive: true, force: true });
  });
});
