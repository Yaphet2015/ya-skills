import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { ensurePrivateFile } from "./artifacts.js";
import { readPngDimensions } from "./image-evidence.js";

// ---------------------------------------------------------------------------
// Same-frame image transforms. Child processes share cancellation and the
// absolute request deadline; every started child must be reaped.

export type ProcessRunner = (
  command: string,
  args: string[],
  options: { timeoutMs: number; signal?: AbortSignal; deadlineAt?: number }
) => Promise<{ stdout: string; stderr: string; code: number | null }>;

export type ResizeControlOptions = { signal?: AbortSignal; deadlineAt?: number };

export function assertResizeAllowed(options: ResizeControlOptions): void {
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

/** Run a bounded transform and preserve child-cleanup failures. */
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

export const DEFAULT_MAX_DIMENSION = 1280;
export const DEFAULT_MAX_PIXELS = 1_000_000;
export const MAX_IMAGE_PIXELS = 64 * 1024 * 1024;

export interface ImageBudget {
  maxDimension?: number;
  maxPixels?: number;
}

export function validateImageBudget(budget: ImageBudget): void {
  if (budget.maxDimension !== undefined &&
      (!Number.isSafeInteger(budget.maxDimension) || budget.maxDimension < 64 || budget.maxDimension > 8192)) {
    throw new Error("maxDimension must be a safe integer between 64 and 8192");
  }
  if (budget.maxPixels !== undefined &&
      (!Number.isSafeInteger(budget.maxPixels) || budget.maxPixels < 1 || budget.maxPixels > MAX_IMAGE_PIXELS)) {
    throw new Error(`maxPixels must be a positive safe integer <= ${MAX_IMAGE_PIXELS}`);
  }
}

/** Cleanup must preserve the original transform or evidence error. */
export function discardScreenshot(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // The artifact may not have been created or may already be removed.
  }
}

/** A budget is an upper bound. Metadata decides whether any transform is needed. */
export async function resizeScreenshot(
  originalPath: string,
  maxDimension: number = DEFAULT_MAX_DIMENSION,
  signal?: AbortSignal,
  runner: ProcessRunner = DEFAULT_RUNNER,
  deadlineAt?: number,
  maxPixels: number = DEFAULT_MAX_PIXELS,
  expected?: { width: number; height: number }
): Promise<ResizeResult> {
  validateImageBudget({ maxDimension, maxPixels });
  const controls = { signal, deadlineAt };
  assertResizeAllowed(controls);
  ensurePrivateFile(originalPath);
  const { width, height } = readPngDimensions(originalPath, expected);
  const scale = Math.min(1, maxDimension / Math.max(width, height), Math.sqrt(maxPixels / (width * height)));
  if (scale === 1) return { path: originalPath, width, height };
  let outWidth = Math.max(1, Math.floor(width * scale));
  let outHeight = Math.max(1, Math.floor(height * scale));
  // A one-pixel short side cannot shrink further. Cap the long side too.
  if (outWidth * outHeight > maxPixels) {
    if (outWidth >= outHeight) {
      outWidth = Math.max(1, Math.floor(maxPixels / outHeight));
    } else {
      outHeight = Math.max(1, Math.floor(maxPixels / outWidth));
    }
  }
  const outputPath = originalPath.replace(/\.png$/i, "") + `-${randomUUID()}.png`;
  try {
    const resized = await runSips(
      ["-z", String(outHeight), String(outWidth), originalPath, "--out", outputPath],
      { timeoutMs: 10_000, signal, deadlineAt }, runner
    );
    if (resized.code !== 0) throw new Error(`sips resize failed: ${resized.stderr.trim()}`);
    ensurePrivateFile(outputPath);
    const actual = readPngDimensions(outputPath);
    if (actual.width !== outWidth || actual.height !== outHeight || actual.width * actual.height > maxPixels) {
      throw new Error(`sips produced invalid dimensions: ${actual.width}x${actual.height}`);
    }
    assertResizeAllowed(controls);
    return { path: outputPath, ...actual };
  } catch (error) {
    discardScreenshot(outputPath);
    throw error;
  }
}

/** Crop coordinates are integer source pixels; callers retain the effective region. */
export async function cropScreenshot(
  originalPath: string,
  outputPath: string,
  region: { x: number; y: number; width: number; height: number },
  controls: ResizeControlOptions = {},
  runner: ProcessRunner = DEFAULT_RUNNER
): Promise<ResizeResult> {
  assertResizeAllowed(controls);
  try {
    const result = await runSips(
      ["--cropOffset", String(region.y), String(region.x), "-c", String(region.height), String(region.width), originalPath, "--out", outputPath],
      { timeoutMs: 10_000, ...controls }, runner
    );
    if (result.code !== 0) throw new Error(`sips crop failed: ${result.stderr.trim()}`);
    ensurePrivateFile(outputPath);
    const actual = readPngDimensions(outputPath, region);
    assertResizeAllowed(controls);
    return { path: outputPath, ...actual };
  } catch (error) {
    discardScreenshot(outputPath);
    throw error;
  }
}
