import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resizeScreenshot, type ProcessRunner } from "../packages/computer-runtime/src/observation-store.js";
import { syntheticPngBuffer } from "./helpers/computer-fixtures.js";

// Injected-runner tests: cross-platform, no sips required.
describe("resizeScreenshot (injected runner)", () => {
  function runnerScripted(steps: Array<{ stdout?: string; stderr?: string; code: number | null }>): ProcessRunner {
    let call = 0;
    return async (_command, _args) => {
      const step = steps[Math.min(call++, steps.length - 1)]!;
      return { stdout: step.stdout ?? "", stderr: step.stderr ?? "", code: step.code ?? 0 };
    };
  }

  test("already-small images return the original without a derived file", async () => {
    let spawns = 0;
    const runner: ProcessRunner = async () => {
      spawns++;
      return { stdout: "pixelWidth: 100\npixelHeight: 80\n", stderr: "", code: 0 };
    };
    const out = await resizeScreenshot("/tmp/a.png", 1600, undefined, runner);
    expect(out).toEqual({ path: "/tmp/a.png", width: 100, height: 80 });
    expect(spawns).toBe(1); // only the dimension probe — no resize spawn
  });

  test("explicit resize derives a new file and verifies real dimensions", async () => {
    const calls: string[][] = [];
    const runner: ProcessRunner = async (_c, args) => {
      calls.push(args);
      if (args[0] === "-g" && args.includes("/tmp/a.png")) {
        return { stdout: "pixelWidth: 2880\npixelHeight: 1800\n", stderr: "", code: 0 };
      }
      return { stdout: "pixelWidth: 1440\npixelHeight: 900\n", stderr: "", code: 0 };
    };
    const out = await resizeScreenshot("/tmp/a.png", 1440, undefined, runner);
    expect(out).toEqual({ path: "/tmp/a-1440.png", width: 1440, height: 900 });
    expect(calls.length).toBe(3);
  });

  test("a failed resize never returns the original as if it were scaled", async () => {
    const runner: ProcessRunner = async (_c, args) => {
      if (args[0] === "-g" && args.includes("/tmp/a.png")) {
        return { stdout: "pixelWidth: 2880\npixelHeight: 1800\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "some sips error", code: 1 };
    };
    await expect(resizeScreenshot("/tmp/a.png", 1440, undefined, runner)).rejects.toThrow(/sips/);
  });

  test("invalid derived dimensions are rejected", async () => {
    const runner: ProcessRunner = async (_c, args) => {
      if (args[0] === "-g" && args.includes("/tmp/a.png")) {
        return { stdout: "pixelWidth: 2880\npixelHeight: 1800\n", stderr: "", code: 0 };
      }
      return { stdout: "pixelWidth: 3000\npixelHeight: 900\n", stderr: "", code: 0 };
    };
    await expect(resizeScreenshot("/tmp/a.png", 1440, undefined, runner)).rejects.toThrow(/invalid dimensions/);
  });

  test("invalid maxDimension is rejected before any spawn", async () => {
    const runner: ProcessRunner = async () => {
      throw new Error("runner must not be called");
    };
    await expect(resizeScreenshot("/tmp/a.png", 0, undefined, runner)).rejects.toThrow(/maxDimension/);
    await expect(resizeScreenshot("/tmp/a.png", Number.POSITIVE_INFINITY, undefined, runner)).rejects.toThrow(/maxDimension/);
  });
});

// Real sips on macOS with an embedded synthetic PNG; explicit skip elsewhere.
describe("resizeScreenshot (real sips, macOS only)", () => {
  const isMacos = process.platform === "darwin";
  const maybe = isMacos ? test : test.skip;

  maybe("derives a genuinely smaller same-format PNG", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cu-sips-"));
    const original = join(dir, "cu.png");
    // The shared fixture matches the runtime's declared 1280x800 geometry.
    // A smaller max dimension exercises the real derivation path.
    await writeFile(original, syntheticPngBuffer());
    const out = await resizeScreenshot(original, 64);
    expect(out.width).toBeLessThanOrEqual(64);
    expect(out.height).toBeLessThanOrEqual(64);
    expect(out.path).not.toBe(original);
    await rm(dir, { recursive: true, force: true });
  });
});
