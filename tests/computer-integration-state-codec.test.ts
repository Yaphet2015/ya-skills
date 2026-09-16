import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sendControl } from "../packages/computer-session/src/client.js";
import { execStateHash, loadExecState } from "../packages/computer-session/src/exec-state.js";
import { startIntegrationStateHost } from "./helpers/integration-state-host.js";

function nestedArrayExpression(depth: number): string {
  let expression = "0";
  for (let index = 0; index < depth; index++) expression = `[${expression}]`;
  return expression;
}

function arrayDepth(value: unknown): number {
  let depth = 0;
  let current = value;
  while (Array.isArray(current)) {
    depth += 1;
    current = current[0];
  }
  return depth;
}

describe("integration state commit and JSON codec boundaries", () => {
  test("cancellation after durable intent abandons only that commit and keeps the host usable", async () => {
    let intentPersisted = false;
    let hostSocketPath = "";
    let sessionId = "";
    let requestId = "";
    const host = await startIntegrationStateHost({
      idleTimeoutMs: 60_000,
      onStateCommitIntent: async (id) => {
        if (intentPersisted) return;
        intentPersisted = true;
        requestId = id;
        const cancel = await sendControl(
          hostSocketPath,
          { kind: "cancel", schemaVersion: 1, sessionId, requestId: id } as never,
          5_000
        );
        expect(cancel.info?.state).toMatch(/running|idle|stopping/);
      }
    });
    hostSocketPath = host.socketPath;
    sessionId = host.sessionId;
    try {
      const cancelled = await host.exec({
        code: "state.n = 1; return 1;",
        timeoutMs: 5_000,
        maxActions: 1
      });
      expect(intentPersisted).toBe(true);
      expect(requestId).toBe("integration-1");
      expect(cancelled.reply.status).toBe("interrupted");
      expect(cancelled.result.status).toBe("interrupted");
      expect(cancelled.result.error?.code).toBe("request_cancelled");
      expect(cancelled.result.stateCommitted).toBe(false);
      expect(cancelled.result.stateVersion).toBe(0);
      expect(loadExecState(join(host.root, host.sessionId, "state"))).toEqual({ version: 0, value: {} });

      const status = await host.control("status");
      expect(status.info?.state).toBe("idle");
      const next = await host.exec({
        code: "state.n = 2; return state.n;",
        timeoutMs: 5_000,
        maxActions: 1
      });
      expect(next.reply.status).toBe("completed");
      expect(next.result.stateCommitted).toBe(true);
      expect(next.result.stateVersion).toBe(1);
      expect(loadExecState(join(host.root, host.sessionId, "state"))).toEqual({ version: 1, value: { n: 2 } });
      const events = await readFile(
        join(host.root, host.sessionId, "requests", requestId, "events.jsonl"),
        "utf8"
      );
      expect(events).toContain('"type":"state_commit_intent"');
      expect(events).toContain('"stateCommitDisposition":"abandoned"');
    } finally {
      await host.close().catch(() => undefined);
      await host.cleanup();
    }
  }, 30_000);

  test("an intent with an unknown terminal outcome still blocks recovery without a commit proof", async () => {
    const host = await startIntegrationStateHost({ idleTimeoutMs: 60_000 });
    try {
      const { createRequestJournal } = await import("@ya-skills/computer-runtime");
      const requests = createRequestJournal(join(host.root, host.sessionId, "requests"));
      const value = { shouldNotBeUsed: true };
      await requests.claim("uncertain", "uncertain-hash");
      await requests.append("uncertain", {
        seq: 0,
        time: Date.now(),
        type: "request_started",
        payload: { kind: "exec" }
      });
      await requests.append("uncertain", {
        seq: 1,
        time: Date.now(),
        type: "state_commit_intent",
        payload: { expectedVersion: 0, version: 1, stateHash: execStateHash(value) }
      });
      await requests.append("uncertain", {
        seq: 2,
        time: Date.now(),
        type: "request_finished",
        payload: {
          status: "unknown",
          result: {
            status: "unknown",
            stateVersion: 0,
            stateCommitted: false,
            actions: [],
            observations: [],
            logs: []
          },
          stateCommitDisposition: "uncertain"
        }
      });
      const next = await host.batch({ actions: [{ kind: "key", key: "Return" }] });
      expect(next.status).toBe("failed");
      expect(next.error?.code).toBe("state_recovery_mismatch");
    } finally {
      await host.close().catch(() => undefined);
      await host.cleanup();
    }
  }, 30_000);

  test("a real encoded exec reply preserves 130 nested arrays and advances state once", async () => {
    const host = await startIntegrationStateHost({ idleTimeoutMs: 60_000 });
    try {
      const nested = nestedArrayExpression(130);
      const first = await host.exec({
        code: `state.payload = ${nested}; return { windowId: "draft", nested: state.payload };`,
        timeoutMs: 5_000,
        maxActions: 1
      });
      expect(first.reply.status).toBe("completed");
      expect(first.result.status).toBe("completed");
      expect(first.result.stateCommitted).toBe(true);
      expect(first.result.stateVersion).toBe(1);
      expect(first.result.value && typeof first.result.value === "object" && !Array.isArray(first.result.value)).toBe(true);
      const value = first.result.value as { windowId: unknown; nested: unknown };
      expect(value.windowId).toBe("draft");
      expect(arrayDepth(value.nested)).toBe(130);
      const state = loadExecState(join(host.root, host.sessionId, "state"));
      expect(state.version).toBe(1);
      expect(arrayDepth(state.value.payload)).toBe(130);
    } finally {
      await host.close().catch(() => undefined);
      await host.cleanup();
    }
  }, 30_000);

  test("values beyond the shared depth bound fail before state commit with a decodable result", async () => {
    const host = await startIntegrationStateHost({ idleTimeoutMs: 60_000 });
    try {
      const tooDeep = nestedArrayExpression(257);
      const rejected = await host.exec({
        code: `state.payload = ${tooDeep}; return 1;`,
        timeoutMs: 5_000,
        maxActions: 1
      });
      expect(rejected.reply.status).toBe("failed");
      expect(rejected.result.status).toBe("failed");
      expect(rejected.result.stateCommitted).toBe(false);
      expect(rejected.result.error?.code).toBe("state_invalid");
      expect(loadExecState(join(host.root, host.sessionId, "state"))).toEqual({ version: 0, value: {} });
    } finally {
      await host.close().catch(() => undefined);
      await host.cleanup();
    }
  }, 30_000);
});
