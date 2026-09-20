// Shared worker spool and watchdog. Process selection stays dependency-free
// so Node can reject unsupported worker launches before loading TS codecs.

import { openSync, readSync, statSync, type Stats } from "node:fs";
import { FrameReader } from "./protocol.js";
import { closeOwnedFd } from "./process.js";
export { internalSpawnCommand, isBunRuntime, spawnWorker, spawnWorkerWithRetry, spawnInternalWorker, closeOwnedFd, stopProcessGroup, TERM_GRACE_MS } from "./process.js";
export type { InternalEntrypoint, SpawnCommand, SpawnedWorker, WorkerSpawnOptions, StopResult } from "./process.js";

export interface SpoolPoll {
  lines: string[];
  /** Bytes read from the spool during this poll. */
  bytesRead: number;
}

export interface SpoolTail {
  complete: boolean;
  pendingBytes: number;
}

export const DEFAULT_SPOOL_CHUNK_BYTES = 64 * 1024;

/** Incrementally read a regular-file NDJSON spool. It detects inode rotation,
 * truncation, invalid UTF-8 and oversized residual frames before a caller can
 * treat worker exit as complete. */
export class FileSpoolReader {
  private fd: number | null = null;
  private ownsFd = false;
  private offset = 0;
  private identity: string | null = null;
  private frameReader = new FrameReader();
  private pendingFrameBytes = 0;

  constructor(
    private readonly path: string,
    private readonly chunkBytes = DEFAULT_SPOOL_CHUNK_BYTES,
    fd?: number
  ) {
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
      throw new Error("spool chunk size must be a positive safe integer");
    }
    this.fd = fd ?? null;
  }

  poll(): SpoolPoll {
    const stats = this.assertCurrentFile();
    if (this.fd === null) {
      this.fd = openSync(this.path, "r");
      this.ownsFd = true;
    }
    const remaining = stats.size - this.offset;
    if (remaining <= 0) return { lines: [], bytesRead: 0 };
    const requested = Math.min(this.chunkBytes, remaining);
    const buffer = Buffer.allocUnsafe(requested);
    const count = readSync(this.fd, buffer, 0, requested, this.offset);
    if (count <= 0) return { lines: [], bytesRead: 0 };
    this.offset += count;
    return { lines: this.consume(buffer.subarray(0, count)), bytesRead: count };
  }

  /** Drain synchronously after the owning process group is proven gone. The
   * second stable EOF check catches a tail that was written between stat and
   * read, including a frame split at the chunk boundary. */
  drainToEofSync(onLines: (lines: string[]) => void = () => undefined): void {
    const state = { stableOffset: null as number | null };
    while (!this.drainStep(state, onLines)) {
      // Keep the sync adapter fully synchronous for exec's exit/finally path.
    }
  }

  /** Async compatibility surface for callers that historically awaited the
   * E2E spool drain. It yields after every bounded read so a large worker-exit
   * tail does not monopolize the supervisor's event loop. */
  async drainToEof(onLines: (lines: string[]) => void = () => undefined): Promise<void> {
    const state = { stableOffset: null as number | null };
    while (!this.drainStep(state, onLines)) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  finalize(): SpoolTail {
    return { complete: this.pendingFrameBytes === 0, pendingBytes: this.pendingFrameBytes };
  }

  close(): void {
    if (this.fd === null) return;
    const fd = this.fd;
    const ownsFd = this.ownsFd;
    this.fd = null;
    this.ownsFd = false;
    if (ownsFd) closeOwnedFd(fd);
  }

  private consume(chunk: Buffer): string[] {
    for (const byte of chunk) {
      if (byte === 0x0a) this.pendingFrameBytes = 0;
      else this.pendingFrameBytes += 1;
    }
    return this.frameReader.push(chunk);
  }

  private drainStep(
    state: { stableOffset: number | null },
    onLines: (lines: string[]) => void
  ): boolean {
    const before = this.offset;
    const poll = this.poll();
    onLines(poll.lines);
    if (poll.bytesRead > 0) {
      state.stableOffset = null;
      return false;
    }
    const stats = this.assertCurrentFile();
    if (stats.size > this.offset || this.offset !== before) {
      state.stableOffset = null;
      return false;
    }
    const probe = Buffer.allocUnsafe(1);
    const count = readSync(this.fd!, probe, 0, 1, this.offset);
    if (count > 0) {
      this.offset += count;
      onLines(this.consume(probe.subarray(0, count)));
      state.stableOffset = null;
      return false;
    }
    const afterProbe = this.assertCurrentFile();
    if (afterProbe.size !== this.offset) {
      state.stableOffset = null;
      return false;
    }
    if (state.stableOffset === this.offset) return true;
    state.stableOffset = this.offset;
    return false;
  }

  private assertCurrentFile(): Stats {
    const stats = statSync(this.path, { bigint: false });
    const identity = `${String(stats.dev)}:${String(stats.ino)}`;
    if (this.identity === null) {
      this.identity = identity;
    } else if (identity !== this.identity) {
      this.resetAfterDiscontinuity();
      this.identity = identity;
      throw new Error("event spool was rotated before the current frame completed");
    }
    if (stats.size < this.offset) {
      this.resetAfterDiscontinuity();
      throw new Error("event spool was truncated before the current frame completed");
    }
    return stats;
  }

  private resetAfterDiscontinuity(): void {
    this.offset = 0;
    this.pendingFrameBytes = 0;
    this.frameReader = new FrameReader();
    this.close();
  }
}

export interface WorkerWatchdog {
  arm(delayMs: number): void;
  clear(): void;
}

export function createWorkerWatchdog(onTimeout: () => void): WorkerWatchdog {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    arm(delayMs: number): void {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(onTimeout, Math.max(delayMs, 1));
    },
    clear(): void {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
    }
  };
}
