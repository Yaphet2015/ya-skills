// Real-socket host fixture for state/codec integration regressions. The only
// fake boundary is the injected driver; request encoding, host admission,
// journal persistence, exec worker, and reply decoding remain production code.

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ComputerError,
  createRequestJournal,
  projectObservation,
  type BatchRequest,
  type BatchResult,
  type Observation,
  type RequestEvent,
  type RequestJournal,
  type Target
} from "@ya-skills/computer-runtime";
import { startHost, type Host, type HostConfig } from "../../packages/computer-session/src/host.js";
import { sendControl, sendRequest } from "../../packages/computer-session/src/client.js";
import type { DriverSessionLike } from "../../packages/computer-session/src/driver-worker.js";
import type { ExecResult } from "../../packages/computer-session/src/exec-types.js";
import type { SessionControlReply, SessionReply, SessionRequest } from "../../packages/computer-session/src/types.js";
import { makeNativeObservation } from "./computer-fixtures.js";

export interface IntegrationStateHostOptions {
  target?: Target;
  idleTimeoutMs?: number;
  /** Runs after the state_commit_intent append has completed durably. */
  onStateCommitIntent?: (requestId: string, event: RequestEvent) => Promise<void> | void;
}

export interface IntegrationStateHost {
  host: Host;
  root: string;
  sessionId: string;
  generation: string;
  target: { pid: number; windowId: string };
  socketPath: string;
  exec(options: {
    code: string;
    sourceName?: string;
    timeoutMs?: number;
    maxActions?: number;
  }): Promise<{ reply: SessionReply; result: ExecResult }>;
  batch(request: BatchRequest): Promise<SessionReply>;
  control(kind: "status" | "close"): Promise<SessionControlReply>;
  send(request: SessionRequest): Promise<SessionReply>;
  close(): Promise<void>;
  cleanup(): Promise<void>;
}

export async function startIntegrationStateHost(
  options: IntegrationStateHostOptions = {}
): Promise<IntegrationStateHost> {
  const root = await mkdtemp(join(tmpdir(), "cu-integration-state-"));
  const sessionId = randomUUID();
  const generation = randomUUID();
  const target = {
    pid: options.target?.pid ?? 800_000 + process.pid,
    windowId: String(options.target?.windowId ?? 98_765n)
  };
  const socketPath = join(tmpdir(), `cu-state-${sessionId.replace(/-/g, "").slice(0, 16)}.sock`);
  const requestsRoot = join(root, sessionId, "requests");
  const baseJournal = createRequestJournal(requestsRoot);
  const journal: RequestJournal = {
    claim: (id, hash) => baseJournal.claim(id, hash),
    read: (id) => baseJournal.read(id),
    list: () => baseJournal.list(),
    async append(id, event) {
      await baseJournal.append(id, event);
      if (event.type === "state_commit_intent") {
        await options.onStateCommitIntent?.(id, event);
      }
    }
  };
  const fakeDriver: DriverSessionLike = {
    async call(method, args, signal) {
      if (method === "observe") {
        if (signal?.aborted) throw new ComputerError("request_cancelled", "observation cancelled");
        const mode = (args.options as { mode?: "auto" | "ax" | "image" | "both" } | undefined)?.mode ?? "ax";
        return projectObservation(
          makeNativeObservation({
            target: { pid: target.pid, windowId: BigInt(target.windowId) }
          }),
          { mode },
          { accessibility: true, screenshot: false }
        );
      }
      if (method === "batch") {
        const request = args.request as BatchRequest;
        if (signal?.aborted) throw new ComputerError("request_cancelled", "batch cancelled");
        const result: BatchResult = {
          status: "completed",
          steps: request.actions.map((action, index) => ({ index, kind: action.kind, status: "delivered" }))
        };
        return result;
      }
      return null;
    },
    async close() {}
  };
  const config: HostConfig = {
    schemaVersion: 1,
    sessionId,
    generation,
    target,
    root,
    socketPath,
    idleTimeoutMs: options.idleTimeoutMs ?? 120_000,
    requestsDir: requestsRoot,
    inProcessDriver: fakeDriver
  };
  const host = await startHost(config, { driver: "in-process", journal: () => journal });
  let requestCounter = 0;
  const makeRequest = (operation: SessionRequest["operation"]): SessionRequest => ({
    schemaVersion: 1,
    sessionId,
    generation,
    requestId: `integration-${++requestCounter}`,
    operation
  });
  return {
    host,
    root,
    sessionId,
    generation,
    target,
    socketPath,
    async exec(execOptions) {
      const reply = await sendRequest(
        socketPath,
        makeRequest({
          kind: "exec",
          code: execOptions.code,
          sourceName: execOptions.sourceName ?? "script.js",
          timeoutMs: execOptions.timeoutMs ?? 5_000,
          maxActions: execOptions.maxActions ?? 100
        }),
        (execOptions.timeoutMs ?? 5_000) + 30_000
      );
      return { reply, result: (reply.result ?? {}) as ExecResult };
    },
    async batch(request) {
      return sendRequest(socketPath, makeRequest({ kind: "batch", request }), 30_000);
    },
    async control(kind) {
      return sendControl(socketPath, { kind, schemaVersion: 1, sessionId } as never, 10_000);
    },
    async send(request) {
      return sendRequest(socketPath, request, 30_000);
    },
    async close() {
      await host.close();
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
      await rm(socketPath, { force: true }).catch(() => undefined);
    }
  };
}
