import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { createObservationStore } from "../packages/computer-runtime/src/observation-store.js";
import { zoomObservation, mapZoomPointToParent } from "../packages/computer-runtime/src/zoom.js";
import { projectObservation } from "../packages/computer-runtime/src/observe.js";
import { makeNativeObservation } from "./helpers/computer-fixtures.js";
import { parseRequest } from "../packages/functions-computer-use/src/args.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cu-zoom-")); dirs.push(root);
  const original = join(root, "original.png");
  const png = new PNG({ width: 1280, height: 800 });
  for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
    const i = (y * png.width + x) * 4;
    png.data[i] = x % 251; png.data[i + 1] = y % 251; png.data[i + 3] = 255;
  }
  writeFileSync(original, PNG.sync.write(png));
  const observation = projectObservation(makeNativeObservation(), { mode: "image" });
  observation.id = randomUUID(); observation.capturedAt = Date.now();
  observation.image.originalPath = original; observation.image.path = original;
  observation.image.geometry!.sentWidth = 791; observation.image.geometry!.sentHeight = 494;
  const store = createObservationStore(join(root, "observations")); await store.save(observation);
  return { root, original, observation, store };
}

test("zoom CLI parses without a target and rejects invalid regions and credentials", () => {
  const id = randomUUID();
  expect(parseRequest("zoom", ["--observation", id, "--region", "10.5,20,30,40", "--max-pixels", "90000"]))
    .toMatchObject({ kind: "zoom", observationId: id, region: { x: 10.5, y: 20, width: 30, height: 40 }, maxPixels: 90000 });
  for (const region of ["1,2,3", "-1,0,2,3", "0,0,0,1", "0,0,NaN,1", "0,,1,1"]) {
    expect(() => parseRequest("zoom", ["--observation", id, "--region", region])).toThrow(/region/);
  }
  expect(() => parseRequest("zoom", ["--observation", "../bad", "--region", "0,0,1,1"])).toThrow(/UUID/);
});

(process.platform === "darwin" ? test : test.skip)("crop retains source detail and maps its effective region into parent coordinates", async () => {
  const f = await fixture();
  const region = { x: 10.3, y: 15.7, width: 101.2, height: 70.8 };
  const zoom = await zoomObservation(f.store, f.observation.id, region, { outDir: f.root });
  expect(zoom.observationId).toBe(f.observation.id);
  expect(zoom.capturedAt).toBe(f.observation.capturedAt);
  expect(zoom.coordinateSpace).toBe("parent-observation");
  const x = Math.floor(region.x * 1280 / 791), y = Math.floor(region.y * 800 / 494);
  const crop = PNG.sync.read(readFileSync(zoom.image.path));
  expect([...crop.data.subarray(0, 4)]).toEqual([x % 251, y % 251, 0, 255]);
  expect(zoom.image.width).toBeGreaterThan(region.width);
  expect(zoom.region.x).toBeCloseTo(x * 791 / 1280, 10);
  const point = { x: zoom.image.width * 0.37, y: zoom.image.height * 0.61 };
  const parent = mapZoomPointToParent(zoom, point);
  expect((parent.x - zoom.region.x) / zoom.region.width).toBeCloseTo(0.37, 10);
  expect((parent.y - zoom.region.y) / zoom.region.height).toBeCloseTo(0.61, 10);
  expect(await f.store.get(f.observation.id)).toEqual(f.observation);
  expect(() => mapZoomPointToParent(zoom, { x: zoom.image.width, y: 0 })).toThrow(/bounds/);
});

test("zoom rejects expired/invalid observations and out-of-bounds regions before a child", async () => {
  const f = await fixture();
  await expect(zoomObservation(f.store, f.observation.id, { x: 790, y: 0, width: 2, height: 2 })).rejects.toMatchObject({ code: "invalid_request" });
  f.observation.capturedAt -= 60_001; await f.store.save(f.observation);
  await expect(zoomObservation(f.store, f.observation.id, { x: 0, y: 0, width: 2, height: 2 })).rejects.toMatchObject({ code: "stale_observation" });
  f.observation.capturedAt = Date.now(); await f.store.save(f.observation); await f.store.invalidate(f.observation.target);
  await expect(zoomObservation(f.store, f.observation.id, { x: 0, y: 0, width: 2, height: 2 })).rejects.toMatchObject({ code: "observation_unavailable" });
});

// Simulate only image transforms; all evidence reads/TTL checks use the real store.
function cropRunner(afterCrop?: () => Promise<void>) {
  return async (_command: string, args: string[]) => {
    const index = args.indexOf("-c");
    if (index < 0) throw new Error("unexpected transform");
    writeFileSync(args[args.indexOf("--out") + 1]!, PNG.sync.write(new PNG({ width: Number(args[index + 2]), height: Number(args[index + 1]) })));
    await afterCrop?.();
    return { stdout: "ok", stderr: "", code: 0 };
  };
}

test("invalidated parent during crop is refused before publication and the crop is removed", async () => {
  const f = await fixture();
  let output = "";
  const runner = cropRunner(async () => { await f.store.invalidate(f.observation.target); });
  await expect(zoomObservation(f.store, f.observation.id, { x: 0, y: 0, width: 10, height: 10 }, {
    outDir: f.root, runner: async (command, args, options) => { output = args[args.indexOf("--out") + 1]!; return runner(command, args); }
  })).rejects.toMatchObject({ code: "observation_unavailable" });
  expect(() => readFileSync(output)).toThrow();
});

test("expiry during crop is refused without extending the parent's capture time", async () => {
  const f = await fixture();
  let reads = 0;
  const store = { ...f.store, get: async (id: string) => {
    const view = await f.store.get(id);
    reads++;
    return reads === 1 ? view : { ...view, capturedAt: Date.now() - 60_001 };
  } };
  await expect(zoomObservation(store, f.observation.id, { x: 0, y: 0, width: 10, height: 10 }, { outDir: f.root, runner: cropRunner() }))
    .rejects.toMatchObject({ code: "stale_observation" });
  expect((await f.store.get(f.observation.id)).capturedAt).toBe(f.observation.capturedAt);
});

test("zoom cancellation and deadline remain active through transforms", async () => {
  const f = await fixture();
  const controller = new AbortController();
  await expect(zoomObservation(f.store, f.observation.id, { x: 0, y: 0, width: 10, height: 10 }, {
    outDir: f.root, signal: controller.signal, runner: cropRunner(async () => { controller.abort(); })
  })).rejects.toMatchObject({ code: "aborted" });
  await expect(zoomObservation(f.store, f.observation.id, { x: 0, y: 0, width: 10, height: 10 }, {
    outDir: f.root, deadlineAt: Date.now() - 1
  })).rejects.toMatchObject({ code: "command_timeout" });
});

test("zoom CLI reads one-shot evidence without creating a native session", async () => {
  const f = await fixture();
  const { createComputerUseCommands } = await import("../packages/functions-computer-use/src/commands.js");
  const zoom = createComputerUseCommands({ createSession: () => { throw new Error("native session must stay lazy"); } }).find((command) => command.action === "zoom")!;
  if (process.platform !== "darwin") return;
  const result = JSON.parse(await zoom.run(["--observation", f.observation.id, "--region", "0,0,10,10", "--out-dir", f.root]) as string);
  expect(result.zoom.observationId).toBe(f.observation.id);
  expect(result.zoom.capturedAt).toBe(f.observation.capturedAt);
});

(process.platform === "darwin" ? test : test.skip)("session zoom reads the session store with no live host, target lookup, or driver", async () => {
  const f = await fixture();
  const { sessionPaths, sessionRoot } = await import("../packages/computer-session/src/index.js");
  const directory = sessionPaths(sessionRoot(), randomUUID()).directory; dirs.push(directory);
  const sessionId = directory.split("/").at(-1)!;
  await createObservationStore(join(directory, "observations")).save(f.observation);
  const { createComputerUseCommands } = await import("../packages/functions-computer-use/src/commands.js");
  const command = createComputerUseCommands({
    createSession: () => { throw new Error("unexpected native session"); },
    sessionTransport: { findSession: async () => { throw new Error("unexpected session transport"); } }
  }).find((command) => command.action === "zoom")!;
  const result = JSON.parse(await command.run(["--session", sessionId, "--observation", f.observation.id, "--region", "0,0,10,10", "--out-dir", f.root]) as string);
  expect(result.zoom.observationId).toBe(f.observation.id);
  expect(result.zoom.image.path.startsWith(f.root)).toBe(true);
});

(process.platform === "darwin" ? test : test.skip)("edge and resized zooms map source coverage back to the parent", async () => {
  const f = await fixture();
  for (const region of [{ x: 0, y: 0, width: 791, height: 494 }, { x: 780, y: 480, width: 11, height: 14 }]) {
    const zoom = await zoomObservation(f.store, f.observation.id, region, { outDir: f.root, maxDimension: 64, maxPixels: 4000 });
    expect(zoom.image.width * zoom.image.height).toBeLessThanOrEqual(4000);
    expect(zoom.image.width).toBeLessThanOrEqual(64);
    const point = mapZoomPointToParent(zoom, { x: zoom.image.width / 2, y: zoom.image.height / 2 });
    expect(point.x).toBeCloseTo(zoom.region.x + zoom.region.width / 2, 10);
    expect(point.y).toBeCloseTo(zoom.region.y + zoom.region.height / 2, 10);
    expect(zoom.region.x + zoom.region.width).toBeLessThanOrEqual(791);
    expect(zoom.region.y + zoom.region.height).toBeLessThanOrEqual(494);
  }
});

test("missing source and failed crops produce structured errors", async () => {
  const f = await fixture();
  await expect(zoomObservation(f.store, f.observation.id, { x: 0, y: 0, width: 10, height: 10 }, {
    outDir: f.root, runner: async () => ({ stdout: "", stderr: "bad image", code: 1 })
  })).rejects.toMatchObject({ code: "artifact_derivation_failed" });
  rmSync(f.original);
  await expect(zoomObservation(f.store, f.observation.id, { x: 0, y: 0, width: 10, height: 10 }, { outDir: f.root }))
    .rejects.toMatchObject({ code: "observation_unavailable" });
});
