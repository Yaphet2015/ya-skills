// Observation provenance store (A3): persists Observation metadata (0600) and
// its image file in a user-cache directory. IDs are UUIDs only; paths are
// derived from the ID by the store itself (no traversal). Saves are
// tmp-file + rename. Invalidations mark records dead rather than deleting
// them — a stale observation must never be clickable again.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateFile } from "./artifacts.js";
import type { ImageGeometry, Observation, Target } from "./types.js";

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
 * match the recorded observation exactly; the original PNG is compared by
 * SHA-256 (encoding changes conservatively refuse). */
export function frameMatchesObservation(
  observation: Observation,
  current: { windowBounds: ImageGeometry["windowBounds"]; pngHash: string }
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
    return pngSha256(observation.image.originalPath) === current.pngHash;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Same-frame derived screenshots via the system sips binary (macOS). Default
// observe path never spawns anything; only an explicit maxDimension does.

export type ProcessRunner = (
  command: string,
  args: string[],
  options: { timeoutMs: number; signal?: AbortSignal; deadlineAt?: number }
) => Promise<{ stdout: string; stderr: string; code: number | null }>;

type ResizeControlOptions = { signal?: AbortSignal; deadlineAt?: number };

function assertResizeAllowed(options: ResizeControlOptions): void {
  if (options.signal?.aborted) throw new Error("screenshot resize was aborted");
  if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) {
    throw new Error("screenshot resize timed out: request deadline expired");
  }
}

function timeoutWithinDeadline(capMs: number, deadlineAt?: number): number {
  if (deadlineAt === undefined) return capMs;
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    throw new Error("screenshot resize timed out: request deadline expired");
  }
  return Math.max(1, Math.min(capMs, remaining));
}

const RESIZE_TERM_GRACE_MS = 100;
const RESIZE_KILL_GRACE_MS = 1_000;

export class ProcessCleanupError extends Error {
  readonly code = "process_cleanup_failed";

  constructor(message: string) {
    super(message);
    this.name = "ProcessCleanupError";
  }
}

async function waitForExit(exited: Promise<boolean>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exited,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function stopBunChild(child: ReturnType<typeof Bun.spawn>): Promise<void> {
  const exited = child.exited.then(
    () => true,
    () => false
  );
  try {
    child.kill("SIGTERM");
  } catch {
    // The process may have exited between the result check and this call.
  }
  if (await waitForExit(exited, RESIZE_TERM_GRACE_MS)) return;

  try {
    child.kill("SIGKILL");
  } catch {
    // The process may have exited while the TERM grace timer was running.
  }
  if (!(await waitForExit(exited, RESIZE_KILL_GRACE_MS))) {
    throw new ProcessCleanupError("sips child did not exit after SIGKILL");
  }
}

async function runNodeChild(
  command: string,
  args: string[],
  options: { timeoutMs: number; signal?: AbortSignal }
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  if (options.signal?.aborted) throw new Error("sips was aborted");
  const { spawn } = require("node:child_process") as typeof import("node:child_process");
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const closed = new Promise<void>((resolve) => {
    child.once("close", resolve);
  });
  const result = new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code: number | null) => {
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code
      });
    });
  });
  const exited = closed.then(
    () => true,
    () => false
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let controlStarted = false;
  let rejectControl: ((error: Error) => void) | undefined;
  const stop = () => {
    cleanupPromise ??= (async () => {
      // A spawn error before pid assignment has no child to reap.
      if (child.pid === undefined) return;
      try {
        child.kill("SIGTERM");
      } catch {
        // The process may have exited between the result check and this call.
      }
      if (await waitForExit(exited, RESIZE_TERM_GRACE_MS)) return;
      try {
        child.kill("SIGKILL");
      } catch {
        // The process may have exited while the TERM grace timer was running.
      }
      if (!(await waitForExit(exited, RESIZE_KILL_GRACE_MS))) {
        throw new ProcessCleanupError("sips child did not close after SIGKILL");
      }
    })();
    return cleanupPromise;
  };
  const stopAndReject = (error: Error): void => {
    if (controlStarted) return;
    controlStarted = true;
    void stop().then(
      () => rejectControl?.(error),
      (cleanupError: unknown) => rejectControl?.(cleanupError instanceof Error ? cleanupError : error)
    );
  };
  const onAbort = () => stopAndReject(new Error("sips was aborted"));
  const control = new Promise<never>((_resolve, reject) => {
    rejectControl = reject;
    timer = setTimeout(() => {
      stopAndReject(new Error("sips timed out after " + options.timeoutMs + "ms"));
    }, options.timeoutMs);
  });
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  try {
    return await Promise.race([result, control]);
  } catch (error) {
    if (cleanupPromise === undefined) {
      cleanupPromise = stop();
      await cleanupPromise;
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    if (cleanupPromise !== undefined) await cleanupPromise;
  }
}

const DEFAULT_RUNNER: ProcessRunner = async (command, args, options) => {
  // Bun 1.3.14's Node child_process pipe setup can intermittently lose a
  // short subprocess result when many desktop-free tests run together. Use
  // Bun's native subprocess API when available; Node-built callers retain
  // the equivalent fallback below.
  if (typeof Bun !== "undefined") {
    if (options.signal?.aborted) throw new Error("sips was aborted");
    const child = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cleanupPromise: Promise<void> | undefined;
    let controlStarted = false;
    let rejectControl: ((error: Error) => void) | undefined;
    const stop = () => {
      cleanupPromise ??= stopBunChild(child);
      return cleanupPromise;
    };
    const stopAndReject = (error: Error): void => {
      if (controlStarted) return;
      controlStarted = true;
      void stop().then(
        () => rejectControl?.(error),
        (cleanupError: unknown) => rejectControl?.(cleanupError instanceof Error ? cleanupError : error)
      );
    };
    const onAbort = () => stopAndReject(new Error("sips was aborted"));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const result = Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited
    ]).then(([stdout, stderr, code]) => ({ stdout, stderr, code }));
    const control = new Promise<never>((_resolve, reject) => {
      rejectControl = reject;
      timer = setTimeout(() => {
        stopAndReject(new Error("sips timed out after " + options.timeoutMs + "ms"));
      }, options.timeoutMs);
    });
    if (options.signal?.aborted) onAbort();
    try {
      return await Promise.race([result, control]);
    } catch (error) {
      if (cleanupPromise === undefined) {
        cleanupPromise = stop();
        await cleanupPromise;
      }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (cleanupPromise !== undefined) await cleanupPromise;
    }
  }
  return runNodeChild(command, args, options);
};

export interface ResizeResult {
  path: string;
  width: number;
  height: number;
}

/** Derive a same-frame scaled PNG from the original capture using
 * /usr/bin/sips -Z. Never upscales (sips -Z already refuses). A failure is a
 * failure: the original is never silently returned as the "scaled" image. */
async function runSips(
  args: string[],
  options: { timeoutMs: number; signal?: AbortSignal; deadlineAt?: number },
  runner: ProcessRunner
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  let last: { stdout: string; stderr: string; code: number | null } | undefined;
  let thrown: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const control = { signal: options.signal, deadlineAt: options.deadlineAt };
    assertResizeAllowed(control);
    const runOptions = {
      ...options,
      timeoutMs: timeoutWithinDeadline(options.timeoutMs, options.deadlineAt)
    };
    try {
      const result = await runner("/usr/bin/sips", args, runOptions);
      // A runner can be injected by tests or a platform wrapper and may not
      // honor either control itself. Check after every child completion before
      // accepting bytes or scheduling another retry.
      assertResizeAllowed(control);
      last = result;
      // A non-zero exit with a concrete diagnostic is a real image error, not
      // a transient process-wiring issue. Retry only empty successful output
      // (the Bun 1.3.14 child-pipe race observed in parallel suites).
      if (result.code !== 0 || result.stdout.trim() !== "") return result;
    } catch (error) {
      // Cleanup failures are evidence that child termination was not proven.
      // Preserve this error even when the request also reached its deadline.
      if (error instanceof ProcessCleanupError) throw error;
      // Preserve request controls even when a child reports a generic error
      // after being killed. This lets the session classify cancellation as an
      // interruption rather than as an artifact failure.
      assertResizeAllowed(control);
      thrown = error;
      const code = typeof error === "object" && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
      if (code !== "ENOENT" || attempt === 2) throw error;
    }
    const waitMs = timeoutWithinDeadline(25, options.deadlineAt);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  assertResizeAllowed({ signal: options.signal, deadlineAt: options.deadlineAt });
  if (thrown !== undefined) throw thrown;
  return last ?? { stdout: "", stderr: "", code: null };
}

export async function resizeScreenshot(
  originalPath: string,
  maxDimension: number,
  signal?: AbortSignal,
  runner: ProcessRunner = DEFAULT_RUNNER,
  deadlineAt?: number
): Promise<ResizeResult> {
  if (!Number.isFinite(maxDimension) || maxDimension <= 0) {
    throw new Error(`maxDimension must be a positive finite number (got: ${maxDimension})`);
  }
  const controls = { signal, deadlineAt };
  assertResizeAllowed(controls);
  const info = await runSips(["-g", "pixelWidth", "-g", "pixelHeight", originalPath], {
    timeoutMs: 5_000,
    signal,
    deadlineAt
  }, runner);
  assertResizeAllowed(controls);
  if (info.code !== 0) {
    throw new Error(`sips could not read ${originalPath}: ${info.stderr.trim()}`);
  }
  const width = Number(/pixelWidth:\s*(\d+)/.exec(info.stdout)?.[1]);
  const height = Number(/pixelHeight:\s*(\d+)/.exec(info.stdout)?.[1]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`sips reported no dimensions for ${originalPath}`);
  }
  // Treat both the source and any derived screenshot as evidence artifacts.
  // Existing permissive source paths are repaired before they can be returned
  // or handed to sips; a chmod/stat error is deliberately fatal.
  if (existsSync(originalPath)) ensurePrivateFile(originalPath);
  assertResizeAllowed(controls);
  const longest = Math.max(width, height);
  if (longest <= maxDimension) {
    // Already within the limit: no derived image needed. The source was
    // repaired/verified above before returning it.
    return { path: originalPath, width, height };
  }
  const outputPath = originalPath.replace(/\.png$/i, "") + `-${maxDimension}.png`;
  const resized = await runSips(
    ["-Z", String(maxDimension), originalPath, "--out", outputPath],
    { timeoutMs: 10_000, signal, deadlineAt },
    runner
  );
  assertResizeAllowed(controls);
  if (resized.code !== 0) {
    throw new Error(`sips resize failed: ${resized.stderr.trim()}`);
  }
  const verify = await runSips(["-g", "pixelWidth", "-g", "pixelHeight", outputPath], {
    timeoutMs: 5_000,
    signal,
    deadlineAt
  }, runner);
  assertResizeAllowed(controls);
  if (verify.code !== 0) {
    throw new Error(`sips could not verify ${outputPath}: ${verify.stderr.trim()}`);
  }
  const outWidth = Number(/pixelWidth:\s*(\d+)/.exec(verify.stdout)?.[1]);
  const outHeight = Number(/pixelHeight:\s*(\d+)/.exec(verify.stdout)?.[1]);
  if (
    !Number.isFinite(outWidth) || !Number.isFinite(outHeight) ||
    outWidth <= 0 || outHeight <= 0 ||
    outWidth > maxDimension || outHeight > maxDimension
  ) {
    throw new Error(`sips produced invalid dimensions for ${outputPath}: ${outWidth}x${outHeight}`);
  }
  // sips may preserve an existing permissive mode and writeFile({ mode })
  // would not fix it. Require the derived file to be private; any chmod/stat
  // failure is evidence-persistence failure, never a best-effort warning.
  if (existsSync(outputPath)) ensurePrivateFile(outputPath);
  assertResizeAllowed(controls);
  return { path: outputPath, width: outWidth, height: outHeight };
}
