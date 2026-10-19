import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resizeScreenshot, type ProcessRunner } from "../packages/computer-runtime/src/observation-store.js";
import { syntheticPngBuffer } from "./helpers/computer-fixtures.js";

// Injected transforms operate on real PNG artifacts, including output validation.
describe("resizeScreenshot (injected runner)", () => {
  test("a failed transform never returns the original as if it were scaled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cu-resize-error-"));
    try {
      const original = join(dir, "capture.png");
      await writeFile(original, syntheticPngBuffer());
      const runner: ProcessRunner = async () => ({ stdout: "", stderr: "some sips error", code: 1 });
      await expect(resizeScreenshot(original, 64, undefined, runner)).rejects.toThrow(/sips resize failed/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("invalid actual output dimensions are rejected", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cu-resize-invalid-"));
    try {
      const original = join(dir, "capture.png");
      await writeFile(original, syntheticPngBuffer());
      const runner: ProcessRunner = async (_c, args) => {
        await writeFile(args[args.indexOf("--out") + 1]!, syntheticPngBuffer());
        return { stdout: "ok", stderr: "", code: 0 };
      };
      await expect(resizeScreenshot(original, 64, undefined, runner)).rejects.toThrow(/invalid dimensions/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("invalid budget and PNG are rejected before any spawn", async () => {
    const runner: ProcessRunner = async () => { throw new Error("runner must not be called"); };
    await expect(resizeScreenshot("/tmp/a.png", 0, undefined, runner)).rejects.toThrow(/maxDimension/);
    await expect(resizeScreenshot("/tmp/a.png", Infinity, undefined, runner)).rejects.toThrow(/maxDimension/);
    const dir = await mkdtemp(join(tmpdir(), "cu-resize-bad-png-"));
    try {
      const original = join(dir, "capture.png");
      await writeFile(original, "not a png");
      await expect(resizeScreenshot(original, 64, undefined, runner)).rejects.toThrow(/PNG/);
    } finally { await rm(dir, { recursive: true, force: true }); }
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
