import type { DriverMethod, DriverSessionLike } from "./driver-worker.js";
import type { StopResult } from "./process.js";

export interface HostConfig {
  schemaVersion: 1;
  sessionId: string;
  generation: string;
  target: { pid: number; windowId: string };
  root: string;
  socketPath: string;
  idleTimeoutMs: number;
  /** Per-session request journal directory (session-private since B3/F7). */
  requestsDir: string;
  /** Internal test injection only (absolute module path). */
  driver?: { kind: "module"; path: string; export?: string };
  /** In-process driver session (tests); overrides `driver`. */
  inProcessDriver?: DriverSessionLike;
}

export interface DriverHandle {
  ready: Promise<void>;
  initCount: number;
  supportsStep?: boolean;
  pid(): number | null;
  call(method: DriverMethod, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  alive(): boolean;
  stop(graceMs?: number): Promise<StopResult>;
}
