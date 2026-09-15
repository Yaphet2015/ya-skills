import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createObservationStore, frameMatchesObservation, pngSha256 } from "../packages/computer-runtime/src/observation-store.js";
import type { Observation } from "../packages/computer-runtime/src/types.js";
import { randomUUID } from "node:crypto";
import { syntheticPngBuffer } from "./helpers/computer-fixtures.js";

async function makeStore(): Promise<{ store: ReturnType<typeof createObservationStore>; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "cu-store-"));
  return { store: createObservationStore(root), root };
}

async function makeObservation(overrides: Partial<Observation> = {}): Promise<Observation> {
  const imageFile = join(await mkdtemp(join(tmpdir(), "cu-img-")), "cu.png");
  await writeFile(imageFile, syntheticPngBuffer());
  return {
    id: randomUUID(),
    target: { pid: 100, windowId: 200n },
    capturedAt: Date.now(),
    epoch: "epoch-1",
    revision: 0,
    title: "T",
    ax: { status: "usable", elements: [], total: 0, returned: 0, complete: true },
    image: {
      status: "usable",
      originalPath: imageFile,
      path: imageFile,
      frameValid: true,
      geometry: {
        sourceWidth: 1280,
        sourceHeight: 800,
        sentWidth: 1280,
        sentHeight: 800,
        inputBounds: { x: 0, y: 0, width: 640, height: 400 },
        windowBounds: { x: 80, y: 40, width: 640, height: 400 }
      }
    },
    ...overrides
  };
}

describe("ObservationStore", () => {
  test("save + cross-process get round-trips metadata", async () => {
    const { store, root } = await makeStore();
    const observation = await makeObservation();
    await store.save(observation);
    // A brand-new store instance (like the next CLI invocation) finds it.
    const again = createObservationStore(root);
    const loaded = await again.get(observation.id);
    expect(loaded.id).toBe(observation.id);
    expect(loaded.image.originalPath).toBe(observation.image.originalPath);
    expect(loaded.target.windowId).toBe(200n);
    await rm(root, { recursive: true, force: true });
  });

  test("non-UUID ids and traversal attempts are rejected", async () => {
    const { store } = await makeStore();
    await expect(store.get("../../etc/passwd")).rejects.toThrow(/UUID/);
    const bad = await makeObservation({ id: "not-a-uuid" });
    await expect(store.save(bad)).rejects.toThrow(/UUID/);
  });

  test("invalidate marks only the target's observations dead", async () => {
    const { store } = await makeStore();
    const a = await makeObservation();
    const b = await makeObservation({ target: { pid: 999, windowId: 1n } });
    await store.save(a);
    await store.save(b);
    await store.invalidate(a.target);
    await expect(store.get(a.id)).rejects.toThrow(/invalidated/);
    await expect(store.get(b.id)).resolves.toBeTruthy();
  });

  test("missing image file makes an observation unusable", async () => {
    const { store } = await makeStore();
    const observation = await makeObservation();
    await store.save(observation);
    await rm(observation.image.originalPath!, { recursive: true, force: true });
    await expect(store.get(observation.id)).rejects.toThrow(/missing/);
  });

  test("corrupt metadata JSON fails loud instead of returning junk", async () => {
    const { store, root } = await makeStore();
    const observation = await makeObservation();
    await store.save(observation);
    await writeFile(join(root, `${observation.id}.json`), "{not json");
    await expect(store.get(observation.id)).rejects.toThrow();
  });

  test("metadata files are user-private (0600)", async () => {
    const { store, root } = await makeStore();
    const observation = await makeObservation();
    await store.save(observation);
    const { statSync } = await import("node:fs");
    const mode = statSync(join(root, `${observation.id}.json`)).mode & 0o777;
    expect(mode).toBe(0o600);
    const dirMode = statSync(root).mode & 0o777;
    expect(dirMode).toBe(0o700);
  });
});

describe("frameMatchesObservation (cross-command freshness)", () => {
  test("identical geometry + identical PNG bytes match", async () => {
    const observation = await makeObservation();
    const hash = pngSha256(observation.image.originalPath!);
    expect(
      frameMatchesObservation(observation, {
        windowBounds: observation.image.geometry!.windowBounds,
        pngHash: hash
      })
    ).toBe(true);
  });

  test("window move/resize refuses old coordinates", async () => {
    const observation = await makeObservation();
    const hash = pngSha256(observation.image.originalPath!);
    expect(
      frameMatchesObservation(observation, {
        windowBounds: { x: 999, y: 40, width: 640, height: 400 },
        pngHash: hash
      })
    ).toBe(false);
    expect(
      frameMatchesObservation(observation, {
        windowBounds: { x: 80, y: 40, width: 700, height: 400 },
        pngHash: hash
      })
    ).toBe(false);
  });

  test("identical geometry but re-encoded pixels conservatively refuses", async () => {
    const observation = await makeObservation();
    // A different valid PNG (different bytes) with the same geometry: the
    // hash check refuses even though the pixels could be visually identical —
    // documented conservative behavior (encoding changes refuse).
    const otherFile = observation.image.originalPath!.replace(".png", "-other.png");
    await writeFile(otherFile, Buffer.concat([syntheticPngBuffer(), Buffer.from([0])]));
    const otherHash = pngSha256(otherFile);
    expect(
      frameMatchesObservation(observation, {
        windowBounds: observation.image.geometry!.windowBounds,
        pngHash: otherHash
      })
    ).toBe(false);
    await rm(otherFile, { force: true });
  });
});
