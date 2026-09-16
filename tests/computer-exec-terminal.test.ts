import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadExecState } from "../packages/computer-session/src/exec-state.js";
import { startTestHost } from "./helpers/session-worker.js";

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("exec terminal reduction", () => {
  test("drains a multi-block terminal frame after the worker exits", async () => {
    const host = await startTestHost({ driver: "fake", idleTimeoutMs: 60_000 });
    try {
      const result = await host.exec({
        code: 'const large = "x".repeat(240_000); state.payload = large; return large;',
        timeoutMs: 5_000,
        maxActions: 1
      });

      expect(result.reply.status).toBe("completed");
      expect(result.result.status).toBe("completed");
      expect(result.result.value).toBe("x".repeat(240_000));
      expect(result.result.stateCommitted).toBe(true);
      const state = loadExecState(join(host.root, host.sessionId, "state"));
      expect(state.value).toEqual({ payload: "x".repeat(240_000) });
    } finally {
      await host.close().catch(() => undefined);
      await host.cleanup();
    }
  }, 30_000);

  test("does not treat an unterminated terminal tail as completion", async () => {
    const host = await startTestHost({ driver: "fake", idleTimeoutMs: 60_000 });
    try {
      const result = await host.exec({
        code: `const { writeSync } = await import("node:fs"); writeSync(3, ${JSON.stringify('{"type":"exec_done","value":')}); process.exit(0);`,
        timeoutMs: 5_000,
        maxActions: 1
      });

      expect(result.reply.status).toBe("interrupted");
      expect(result.result.status).toBe("interrupted");
      expect(result.result.error?.code).toBe("worker_exit");
      expect(result.result.stateCommitted).toBe(false);
    } finally {
      await host.close().catch(() => undefined);
      await host.cleanup();
    }
  }, 30_000);

  test("fails closed when the control spool shrinks before EOF", async () => {
    const host = await startTestHost({ driver: "fake", idleTimeoutMs: 60_000 });
    try {
      const result = await host.exec({
        code: 'const { writeSync, ftruncateSync } = await import("node:fs"); writeSync(3, JSON.stringify({ type: "exec_started", sourceName: "script.js" }) + "\\n"); await new Promise((resolve) => setTimeout(resolve, 100)); ftruncateSync(3, 0); process.exit(0);',
        timeoutMs: 5_000,
        maxActions: 1
      });

      expect(result.reply.status).toBe("interrupted");
      expect(result.result.status).toBe("interrupted");
      expect(result.result.error?.code).toBe("worker_exit");
      expect(result.result.stateCommitted).toBe(false);
    } finally {
      await host.close().catch(() => undefined);
      await host.cleanup();
    }
  }, 30_000);

  test("terminal receipt closes admission for every queued independent RPC", async () => {
    let batchCalls = 0;
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const host = await startTestHost({
      driver: "fake",
      target: { pid: 707_001, windowId: 707_001n },
      idleTimeoutMs: 60_000,
      batchResult: async (request) => {
        batchCalls += 1;
        await held;
        return {
          status: "completed",
          steps: request.actions.map((action, index) => ({ index, kind: action.kind, status: "delivered" as const }))
        };
      }
    });
    const terminalMarker = join(host.root, "script-terminal");
    try {
      const running = host.exec({
        code: `const { writeFileSync } = await import("node:fs"); void computer.key("A"); void computer.key("B"); writeFileSync(${JSON.stringify(terminalMarker)}, "terminal"); return 1;`,
        timeoutMs: 5_000,
        maxActions: 2
      });
      await waitForFile(terminalMarker);
      release?.();
      const result = await running;

      expect(result.reply.status).toBe("failed");
      expect(result.result.status).toBe("failed");
      expect(result.result.error?.code).toBe("unawaited_actions");
      expect(batchCalls).toBeLessThanOrEqual(1);
      expect(result.result.actions).toHaveLength(2);
      expect(result.result.actions[0]?.status).toBe(batchCalls === 1 ? "delivered" : "not_run");
      expect(result.result.actions[1]?.status).toBe("not_run");
      expect(result.result.stateCommitted).toBe(false);
    } finally {
      release?.();
      await host.close().catch(() => undefined);
      await host.cleanup();
    }
  }, 30_000);

  test("keeps a dispatched RPC result and rejects only later queued work", async () => {
    let batchCalls = 0;
    const host = await startTestHost({
      driver: "fake",
      target: { pid: 707_002, windowId: 707_002n },
      idleTimeoutMs: 60_000,
      batchResult: async (request) => {
        batchCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 200));
        return {
          status: "completed",
          steps: request.actions.map((action, index) => ({ index, kind: action.kind, status: "delivered" as const }))
        };
      }
    });
    try {
      const result = await host.exec({
        code: "void computer.key('A'); await new Promise((resolve) => setTimeout(resolve, 100)); void computer.key('B'); return 1;",
        timeoutMs: 5_000,
        maxActions: 2
      });

      expect(result.reply.status).toBe("failed");
      expect(result.result.error?.code).toBe("unawaited_actions");
      expect(batchCalls).toBe(1);
      expect(result.result.actions.map((receipt) => [receipt.index, receipt.kind, receipt.status])).toEqual([
        [0, "key", "delivered"],
        [1, "key", "not_run"]
      ]);
      expect(result.result.stateCommitted).toBe(false);
    } finally {
      await host.close().catch(() => undefined);
      await host.cleanup();
    }
  }, 30_000);

  test("keeps an unawaited observe terminal reply decodable", async () => {
    const host = await startTestHost({ driver: "fake", idleTimeoutMs: 60_000 });
    try {
      const result = await host.exec({
        code: "void computer.observe({mode:'ax'}); return 1;",
        timeoutMs: 5_000,
        maxActions: 1
      });

      expect(result.reply.status).toBe("failed");
      expect(result.result.status).toBe("failed");
      expect(result.result.error?.code).toBe("unawaited_actions");
      expect(result.result.actions).toEqual([]);
      expect(result.result.stateCommitted).toBe(false);
    } finally {
      await host.close().catch(() => undefined);
      await host.cleanup();
    }
  }, 30_000);

  test("does not turn an observe failure into an invalid action receipt", async () => {
    const host = await startTestHost({
      driver: "fake",
      idleTimeoutMs: 60_000,
      observeResult: async () => {
        throw new Error("observation unavailable");
      }
    });
    try {
      const result = await host.exec({
        code: "try { await computer.observe({mode:'ax'}); } catch { return 1; }",
        timeoutMs: 5_000,
        maxActions: 1
      });

      expect(result.reply.status).toBe("failed");
      expect(result.result.status).toBe("failed");
      expect(result.result.error?.code).toBe("final_observe_failed");
      expect(result.result.actions).toEqual([]);
      expect(result.result.stateCommitted).toBe(true);
    } finally {
      await host.close().catch(() => undefined);
      await host.cleanup();
    }
  }, 30_000);
});
