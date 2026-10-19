// Observation provenance store (A3): persists Observation metadata (0600) and
// its image file in a user-cache directory. IDs are UUIDs only; paths are
// derived from the ID by the store itself (no traversal). Saves are
// tmp-file + rename. Invalidations mark records dead rather than deleting
// them — a stale observation must never be clickable again.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateFile } from "./artifacts.js";
import { isSupportedPng, matchesBoundedPngEvidence } from "./image-evidence.js";
import type { ImageGeometry, Observation, Point, Target } from "./types.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ObservationStore {
  save(value: Observation): Promise<void>;
  get(id: string): Promise<Observation>;
  /** Mark every observation of this target invalid (mutation started). */
  invalidate(target: Target): Promise<void>;
}

interface StoredObservation extends Observation {
  valid: boolean;
}

function ensureRoot(root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
}

function metaPath(root: string, id: string): string {
  if (!UUID_RE.test(id)) {
    throw new Error(`observation id must be a UUID (got: ${id})`);
  }
  return join(root, `${id}.json`);
}

function readStored(root: string, id: string): StoredObservation {
  const raw = readFileSync(metaPath(root, id), "utf8");
  const parsed = JSON.parse(raw) as StoredObservation;
  if (typeof parsed !== "object" || parsed === null || parsed.id !== id) {
    throw new Error(`observation metadata corrupt for ${id}`);
  }
  if (parsed.valid === false) {
    throw new Error(`observation ${id} was invalidated`);
  }
  // JSON turns bigint into a decimal string; restore the target identity.
  if (parsed.target && typeof parsed.target.windowId === "string") {
    parsed.target = { ...parsed.target, windowId: BigInt(parsed.target.windowId) };
  }
  for (const imagePath of [parsed.image?.originalPath, parsed.image?.path]) {
    if (imagePath === undefined) continue;
    try {
      // Existing paths may have been created by copyFile/sips with a
      // permissive mode. Repair and verify them before making the observation
      // usable as a click credential; permission failures are not swallowed.
      ensurePrivateFile(imagePath);
      const stats = statSync(imagePath);
      if (!stats.isFile() || stats.size <= 0) throw new Error("empty or non-regular image file");
    } catch (error) {
      const code = typeof error === "object" && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
      if (code === "ENOENT" || code === "ENOTDIR") {
        throw new Error(`observation ${id} image file is missing or unusable`);
      }
      throw new Error(
        `observation ${id} image file failed privacy validation: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return parsed;
}

export function createObservationStore(root: string): ObservationStore {
  ensureRoot(root);
  return {
    async save(value: Observation): Promise<void> {
      if (!UUID_RE.test(value.id)) {
        throw new Error(`observation id must be a UUID (got: ${value.id})`);
      }
      for (const imagePath of [value.image?.originalPath, value.image?.path]) {
        if (imagePath !== undefined) ensurePrivateFile(imagePath);
      }
      const stored: StoredObservation = { ...value, valid: true };
      const target = metaPath(root, value.id);
      const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmp, JSON.stringify(stored, bigintReplacer), { mode: 0o600 });
      renameSync(tmp, target);
    },
    async get(id: string): Promise<Observation> {
      const stored = readStored(root, id);
      const { valid: _valid, ...rest } = stored;
      return rest as unknown as Observation;
    },
    async invalidate(target: Target): Promise<void> {
      // Scan metadata files; each invalid record is rewritten atomically.
      const { readdirSync } = await import("node:fs");
      for (const entry of readdirSync(root)) {
        if (!entry.endsWith(".json")) continue;
        const path = join(root, entry);
        try {
          const parsed = JSON.parse(readFileSync(path, "utf8")) as StoredObservation;
          if (parsed.valid === false) continue;
          if (parsed.target?.pid === target.pid && String(parsed.target?.windowId) === String(target.windowId)) {
            const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
            writeFileSync(tmp, JSON.stringify({ ...parsed, valid: false }, bigintReplacer), { mode: 0o600 });
            renameSync(tmp, path);
          }
        } catch {
          // Unreadable records are already unusable for clicks.
        }
      }
    }
  };
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function pngSha256(path: string): string {
  const data = readFileSync(path);
  return createHash("sha256").update(data).digest("hex");
}

/** Fresh-frame comparison for cross-command visual clicks (A4): geometry must
 * match the recorded observation exactly. Identical PNG bytes take the fast
 * path. When the bytes differ, the caller must provide the fresh PNG and the
 * requested click point so the strict target-neighbourhood + bounded global
 * pixel comparison can prove that the target remains stable. */
export function frameMatchesObservation(
  observation: Observation,
  current: {
    windowBounds: ImageGeometry["windowBounds"];
    pngHash: string;
    /** Persisted fresh frame. Required when the PNG hash differs. */
    pngPath?: string;
    /** Point in the observation's sent-image pixel coordinate space. */
    point?: Point;
  }
): boolean {
  const geometry = observation.image.geometry;
  if (!geometry) return false;
  const a = geometry.windowBounds;
  const b = current.windowBounds;
  if (
    a.x !== b.x || a.y !== b.y || a.width !== b.width || a.height !== b.height
  ) {
    return false;
  }
  if (observation.image.originalPath === undefined) return false;
  try {
    const stats = statSync(observation.image.originalPath);
    if (!stats.isFile()) return false;
    const originalHash = pngSha256(observation.image.originalPath);
    if (originalHash === current.pngHash) {
      // A hash match is still required to decode as a supported PNG. This
      // prevents malformed or unsupported fixtures from becoming click
      // credentials through the exact-match fast path.
      if (current.pngPath !== undefined) {
        const freshStats = statSync(current.pngPath);
        if (!freshStats.isFile() || pngSha256(current.pngPath) !== current.pngHash) return false;
        return isSupportedPng(current.pngPath, {
          width: geometry.sourceWidth,
          height: geometry.sourceHeight
        });
      }
      return isSupportedPng(observation.image.originalPath, {
        width: geometry.sourceWidth,
        height: geometry.sourceHeight
      });
    }
    // Older direct callers that only provide a hash cannot safely prove which
    // pixels changed. Keep that API fail-closed; the session path always
    // supplies the fresh artifact and click coordinate.
    if (current.pngPath === undefined || current.point === undefined) return false;
    const freshStats = statSync(current.pngPath);
    if (!freshStats.isFile() || pngSha256(current.pngPath) !== current.pngHash) return false;
    return matchesBoundedPngEvidence(
      observation.image.originalPath,
      current.pngPath,
      current.point,
      {
        sentWidth: geometry.sentWidth,
        sentHeight: geometry.sentHeight,
        sourceWidth: geometry.sourceWidth,
        sourceHeight: geometry.sourceHeight
      }
    );
  } catch {
    return false;
  }
}

export { resizeScreenshot, ProcessCleanupError, type ProcessRunner, type ResizeResult } from "./screenshot.js";
