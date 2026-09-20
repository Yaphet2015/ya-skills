// In-process test host with an injected fake driver. All public methods use
// the REAL socket and client — only the driver session is fake. No SDK
// import, no desktop.

import { randomUUID } from "node:crypto";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHost, type Host, type HostConfig, type HostDeps } from "../../packages/computer-session/src/host.js";
import type { DriverConfig, DriverSessionLike } from "../../packages/computer-session/src/driver-worker.js";
import type { ExecResult } from "../../packages/computer-session/src/exec-types.js";
import { sendControl, sendRequest } from "../../packages/computer-session/src/client.js";
import type {
  SessionControlReply,
  SessionReply,
  SessionRequest
} from "../../packages/computer-session/src/types.js";
import type {
  BatchRequest,
  BatchResult,
  Observation,
  Target
} from "@ya-skills/computer-runtime";
import { ComputerError, projectObservation } from "@ya-skills/computer-runtime";
import { makeNativeObservation } from "./computer-fixtures.js";

/** Factory used by the standalone opener lifecycle regression. The spawned
 * production host still owns a real socket/process boundary; only its driver
 * is replaced with this desktop-free fixture. */
export function createLaneFakeDriver(config: DriverConfig): DriverSessionLike {
  return {
    async call(method, args) {
      if (method === "observe") {
        return projectObservation(
          makeNativeObservation({ target: { pid: config.target.pid, windowId: BigInt(config.target.windowId) } }),
          { mode: ((args.options as { mode?: "auto" | "ax" | "image" | "both" } | undefined)?.mode ?? "ax") },
          { accessibility: true, screenshot: false }
        );
      }
      if (method === "batch") {
        const request = args.request as BatchRequest;
        return {
          status: "completed",
          steps: request.actions.map((action, index) => ({ index, kind: action.kind, status: "delivered" }))
        };
      }
      return null;
    },
    async close() {}
  };
}

export interface FakeDriverOptions {
  /** Runtime override of what the fake batch returns. */
  batchResult?: (request: BatchRequest, signal?: AbortSignal) => BatchResult | Promise<BatchResult>;
  /** Thrown (as a ComputerError-shaped failure) by every fake batch call. */
  batchError?: { code: string; message: string };
  /** Optional action outcome used to exercise transport classification. */
  batchErrorOutcome?: "delivered" | "not_delivered" | "unknown";
  observeDelayMs?: number;
  observeResult?: (signal?: AbortSignal) => Observation | Promise<Observation>;
  observeElementLabelBytes?: number;
}

export interface TestHostHandle {
  host: Host;
  /** Every fake driver method call, for reuse assertions. */
  fakeCalls: string[];
  sessionId: string;
  generation: string;
  root: string;
  target: { pid: number; windowId: string };
  socketPath: string;
  observe(options?: { mode?: "auto" | "ax" | "image" | "both" }): Promise<Observation>;
  batch(request: BatchRequest): Promise<SessionReply>;
  exec(options: { code: string; sourceName?: string; timeoutMs?: number; maxActions?: number }): Promise<{ reply: SessionReply; result: ExecResult }>;
  batchRequest(actions: BatchRequest["actions"]): SessionRequest;
  send(request: SessionRequest): Promise<SessionReply>;
  control(kind: "status" | "close"): Promise<SessionControlReply>;
  diagnostics(): Promise<{ driverInitCount: number; deliveries: number } & Record<string, unknown>>;
  close(): Promise<void>;
  cleanup(): Promise<void>;
}

export type TestHostOptions = {
  journal?: HostDeps["journal"];
  driver?: "fake";
  idleTimeoutMs?: number;
  target?: Target;
  execTimeoutMs?: number;
  /** Share a production-style session root to test isolation/ownership. */
  root?: string;
  /** Reopen the same session directory to exercise durable recovery. */
  sessionId?: string;
  generation?: string;
} & FakeDriverOptions;

export async function startTestHost(options: TestHostOptions = {}): Promise<TestHostHandle> {
  const root = options.root ?? (await mkdtemp(join(tmpdir(), "cu-host-")));
  const sessionId = options.sessionId ?? randomUUID();
  const generation = options.generation ?? randomUUID();
  const target = { pid: options.target?.pid ?? 4242, windowId: String(options.target?.windowId ?? 12345n) };
  const fakeCalls: string[] = [];
  const session: DriverSessionLike = {
    async call(method, args, signal) {
      fakeCalls.push(method);
      if (method === "observe") {
        if (options.driver !== "fake") throw new Error("fake driver only");
        const observeResult = (options as FakeDriverOptions).observeResult;
        if (observeResult !== undefined) return observeResult(signal);
        const delay = (options as FakeDriverOptions).observeDelayMs ?? 0;
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        const raw = makeNativeObservation({
          target: { pid: Number(target.pid), windowId: BigInt(target.windowId) },
          ...(options.observeElementLabelBytes !== undefined
            ? { elements: [{ elementIndex: 0n, role: "AXStaticText", label: "x".repeat(options.observeElementLabelBytes) }] }
            : {})
        });
        const mode = (args.options as { mode?: "auto" | "ax" | "image" | "both" } | undefined)?.mode;
        return projectObservation(raw, { mode: mode ?? "ax" }, { accessibility: true, screenshot: false });
      }
      if (method === "batch") {
        const request = args.request as BatchRequest;
        const batchError = (options as FakeDriverOptions).batchError;
        if (batchError) {
          // A REAL ComputerError so the host's instanceof checks classify it.
          throw new ComputerError(batchError.code, batchError.message, options.batchErrorOutcome);
        }
        const override = await (options as FakeDriverOptions).batchResult?.(request, signal);
        if (override) return override;
        return {
          status: "completed",
          steps: request.actions.map((action, index) => ({ index, kind: action.kind, status: "delivered" }))
        };
      }
      if (method === "close") return null;
      throw new Error(`unknown method ${method}`);
    },
    async close() {
      fakeCalls.push("close");
    }
  };
  // Unix socket paths have a small platform limit; keep the test endpoint
  // in the short temp socket namespace just like production paths.
  const socketPath = join(tmpdir(), `cu-test-${sessionId.replace(/-/g, "").slice(0, 16)}.sock`);
  const config: HostConfig = {
    schemaVersion: 1,
    sessionId,
    generation,
    target,
    root,
    socketPath,
    idleTimeoutMs: options.idleTimeoutMs ?? 120_000,
    requestsDir: join(root, "requests"),
    inProcessDriver: session
  };
  const host = await startHost(config, { driver: "in-process", journal: options.journal });
  let requestCounter = 0;
  const base = {
    host,
    sessionId,
    generation,
    root,
    target,
    socketPath
  };
  const makeRequest = (operation: SessionRequest["operation"]): SessionRequest => ({
    schemaVersion: 1,
    sessionId,
    generation,
    requestId: `req-${++requestCounter}`,
    operation
  });
  const handle: TestHostHandle = {
    ...base,
    fakeCalls,
    async observe(observerOptions) {
      const reply = await sendRequest(socketPath, makeRequest({ kind: "observe", options: observerOptions as never }), 10_000);
      if (reply.error) throw new Error(`${reply.error.code}: ${reply.error.message}`);
      return reply.result as Observation;
    },
    async batch(request: BatchRequest) {
      return sendRequest(socketPath, makeRequest({ kind: "batch", request }), 30_000);
    },
    async exec(execOptions: { code: string; sourceName?: string; timeoutMs?: number; maxActions?: number }) {
      const reply = await sendRequest(
        socketPath,
        makeRequest({
          kind: "exec",
          code: execOptions.code,
          sourceName: execOptions.sourceName ?? "script.js",
          timeoutMs: execOptions.timeoutMs ?? 60_000,
          maxActions: execOptions.maxActions ?? 100
        }),
        (execOptions.timeoutMs ?? 60_000) + 30_000
      );
      return { reply, result: (reply.result ?? {}) as never };
    },
    batchRequest(actions: BatchRequest["actions"]): SessionRequest {
      return makeRequest({ kind: "batch", request: { actions } });
    },
    async send(request: SessionRequest) {
      return sendRequest(socketPath, request, 30_000);
    },
    async control(kind: "status" | "close") {
      return sendControl(socketPath, { kind, schemaVersion: 1, sessionId } as never, 10_000);
    },
    async diagnostics() {
      const reply = (await sendControl(
        socketPath,
        { kind: "diagnostics", schemaVersion: 1, sessionId } as never,
        10_000
      )) as SessionControlReply & { diagnostics?: Record<string, unknown> };
      return { ...(reply.diagnostics ?? {}) } as { driverInitCount: number; deliveries: number };
    },
    async close() {
      await host.close();
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  };
  return handle;
}
