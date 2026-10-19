import { PNG } from "pngjs";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resizeScreenshot, type ProcessRunner } from "../packages/computer-runtime/src/observation-store.js";
import { createSessionWithBackend } from "../packages/computer-runtime/src/session.js";
import { fakeBackendFactory, FIXTURE_TARGET, makeNativeObservation } from "./helpers/computer-fixtures.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function image(width: number, height: number): string {
  const dir = mkdtempSync(join(tmpdir(), "cu-budget-"));
  dirs.push(dir);
  const path = join(dir, "original.png");
  writeFileSync(path, PNG.sync.write(new PNG({ width, height })));
  return path;
}

test("auto with explicit image budgets uses one usable AX read and no derivation", async () => {
  let reads = 0;
  let resizes = 0;
  const session = createSessionWithBackend({ load: async () => ({}), create: fakeBackendFactory({
    observe: async () => { reads++; return makeNativeObservation(); }
  }) }, { screenshotResizer: async () => { resizes++; throw new Error("unexpected image derivation"); } });
  try {
    const view = await session.computer.observe(FIXTURE_TARGET, { mode: "auto", maxDimension: 1280, maxPixels: 1_000_000 });
    expect(view.image.status).toBe("unavailable");
    expect(reads).toBe(1);
    expect(resizes).toBe(0);
  } finally { await session.close(); }
});

test("small image reuses original with zero child processes", async () => {
  const path = image(320, 200);
  let children = 0;
  const runner: ProcessRunner = async () => { children++; throw new Error("unexpected child"); };
  expect(await resizeScreenshot(path, 1280, undefined, runner)).toEqual({ path, width: 320, height: 200 });
  expect(children).toBe(0);
});

for (const [width, height] of [[2000, 2000], [2880, 1800], [1800, 2880], [900, 900]]) {
  test(`budget bounds ${width}x${height} and verifies actual output`, async () => {
    const path = image(width!, height!);
    const calls: string[][] = [];
    const runner: ProcessRunner = async (_command, args) => {
      calls.push(args);
      expect(args[0]).toBe("-z");
      writeFileSync(args[args.indexOf("--out") + 1]!, PNG.sync.write(new PNG({ width: Number(args[2]), height: Number(args[1]) })));
      return { stdout: "ok", stderr: "", code: 0 };
    };
    const out = await resizeScreenshot(path, 1280, undefined, runner);
    expect(out.width).toBeLessThanOrEqual(1280);
    expect(out.height).toBeLessThanOrEqual(1280);
    expect(out.width * out.height).toBeLessThanOrEqual(1_000_000);
    expect(calls).toHaveLength(width! * height! <= 1_000_000 && Math.max(width!, height!) <= 1280 ? 0 : 1);
  });
}

test("dimension and pixel limits can be overridden independently", async () => {
  const path = image(2000, 2000);
  const runner: ProcessRunner = async (_command, args) => {
    writeFileSync(args[args.indexOf("--out") + 1]!, PNG.sync.write(new PNG({ width: Number(args[2]), height: Number(args[1]) })));
    return { stdout: "ok", stderr: "", code: 0 };
  };
  const pixelsOnly = await resizeScreenshot(path, 2000, undefined, runner);
  expect([pixelsOnly.width, pixelsOnly.height]).toEqual([1000, 1000]);
  const dimensionOnly = await resizeScreenshot(path, 1280, undefined, runner, undefined, 4_000_000);
  expect([dimensionOnly.width, dimensionOnly.height]).toEqual([1280, 1280]);
  expect(await resizeScreenshot(path, 2000, undefined, runner, undefined, 4_000_000)).toMatchObject({ path, width: 2000, height: 2000 });
  const thin = await resizeScreenshot(image(8192, 1), 1280, undefined, runner, undefined, 1);
  expect([thin.width, thin.height]).toEqual([1, 1]);
});

test("source geometry mismatch fails before an image child or publication", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cu-budget-mismatch-")); dirs.push(dir);
  let saved = false;
  const session = createSessionWithBackend({ load: async () => ({}), create: fakeBackendFactory({
    observe: async () => makeNativeObservation({ screenshotWidth: 640 })
  }) }, { artifactsDir: dir, observationStore: { save: async () => { saved = true; }, get: async () => { throw new Error("unused"); }, invalidate: async () => {} } });
  try {
    await expect(session.computer.observe(FIXTURE_TARGET, { mode: "image" })).rejects.toMatchObject({ code: "artifact_derivation_failed" });
    expect(saved).toBe(false);
  } finally { await session.close(); }
});
