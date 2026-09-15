import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { startTestHost } from "./helpers/session-worker.js";
import { sendControl, sendRequest } from "../packages/computer-session/src/client.js";
import type { BatchRequest } from "@ya-skills/computer-runtime";

describe("session host (B2)", () => {
  test("the plan's reference case: driver reuse across observes", async () => {
    const host = await startTestHost({ driver: "fake", idleTimeoutMs: 500 });
    try {
      await host.observe({ mode: "ax" });
      await host.observe({ mode: "ax" });
      expect((await host.diagnostics()).driverInitCount).toBe(1);
      expect((await host.control("status")).info?.state).toBe("idle");
    } finally {
      await host.close();
      await host.cleanup();
    }
  });

  test("idle timeout closes the session only when nothing is in flight", async () => {
    const host = await startTestHost({ driver: "fake", idleTimeoutMs: 200 });
    try {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const info = await host.host.waitUntilClosed();
      expect(info.state).toBe("closed");
      // The socket is gone: further sends fail with a connection error.
      const error = await sendRequest(
        host.socketPath,
        {
          schemaVersion: 1,
          sessionId: host.sessionId,
          generation: host.generation,
          requestId: "after-close",
          operation: { kind: "observe" }
        },
        2_000
      ).then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
    } finally {
      await host.cleanup();
    }
  });

  test("status does not extend the idle timer and never calls the driver", async () => {
    const host = await startTestHost({ driver: "fake", idleTimeoutMs: 300 });
    try {
      for (let i = 0; i < 4; i++) {
        await host.control("status").catch(() => undefined); // socket may already be gone
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const info = await host.host.waitUntilClosed();
      expect(info.state).toBe("closed");
      // status never CALLED the driver; the single "close" is the idle
      // shutdown reclaiming the driver worker.
      expect(host.fakeCalls).toEqual(["close"]);
    } finally {
      await host.cleanup();
    }
  });

  test("a running request answers concurrent requests with session_busy", async () => {
    const host = await startTestHost({
      driver: "fake",
      idleTimeoutMs: 60_000,
      observeDelayMs: 300
    });
    try {
      const slow = host.observe({});
      const busy = await host.batch({ actions: [{ kind: "key", key: "Return" }] });
      expect(busy.status).toBe("failed");
      expect(busy.error?.code).toBe("session_busy");
      await slow;
      expect((await host.control("status")).info?.state).toBe("idle");
    } finally {
      await host.close();
      await host.cleanup();
    }
  });

  test("batch replies decode BatchResult with per-step receipts", async () => {
    const host = await startTestHost({ driver: "fake" });
    try {
      const reply = await host.batch({
        actions: [
          { kind: "click", selector: { text: "OK", match: "exact" } },
          { kind: "type", text: "hi" }
        ]
      });
      expect(reply.status).toBe("completed");
      const result = reply.result as { status: string; steps: Array<{ status: string }> };
      expect(result.status).toBe("completed");
      expect(result.steps.map((s) => s.status)).toEqual(["delivered", "delivered"]);
      expect((await host.diagnostics()).deliveries).toBe(2);
    } finally {
      await host.close();
      await host.cleanup();
    }
  });

  test("a failed or interrupted batch result never maps to a successful reply", async () => {
    for (const status of ["failed", "interrupted"] as const) {
      const host = await startTestHost({
        driver: "fake",
        batchResult: () => ({
          status,
          steps: [{ index: 0, kind: "key", status: status === "interrupted" ? "unknown" : "not_delivered", error: { code: "fixture", message: status } }]
        })
      });
      try {
        const reply = await host.batch({
          actions: [{ kind: "key", key: "Escape" }]
        });
        expect(reply.status).not.toBe("completed");
        expect(reply.result).toBeTruthy();
        if (status === "interrupted") expect(reply.status).toBe("unknown");
      } finally {
        await host.close();
        await host.cleanup();
      }
    }
  });

  test("generation mismatches are refused", async () => {
    const host = await startTestHost({ driver: "fake" });
    try {
      const reply = await sendRequest(
        host.socketPath,
        {
          schemaVersion: 1,
          sessionId: host.sessionId,
          generation: randomUUID(),
          requestId: "stale-gen",
          operation: { kind: "observe", options: { mode: "ax" } }
        },
        5_000
      );
      expect(reply.error?.code).toBe("stale_generation");
    } finally {
      await host.close();
      await host.cleanup();
    }
  });

  test("business payload text cannot be mistaken for a control command", async () => {
    const host = await startTestHost({ driver: "fake" });
    try {
      const reply = await host.exec({ code: "const text = '\"kind\":\"status\"'; return text;" });
      expect(reply.reply.status).toBe("completed");
      expect(reply.result.value).toBe('"kind":"status"');
    } finally {
      await host.close();
      await host.cleanup();
    }
  });

  test("exec with structurally invalid input fails loud before any script runs", async () => {
    const host = await startTestHost({ driver: "fake" });
    try {
      const reply = await host.send({
        schemaVersion: 1,
        sessionId: host.sessionId,
        generation: host.generation,
        requestId: "exec-invalid",
        operation: { kind: "exec", code: "", sourceName: "x.js", timeoutMs: 1000, maxActions: 10 }
      });
      expect(reply.status).toBe("failed");
      expect(reply.error?.code).toBe("invalid_code");
    } finally {
      await host.close();
      await host.cleanup();
    }
  });

  test("cancellation during final observation reports an interrupted batch", async () => {
    let observeStartedResolve!: () => void;
    const observeStarted = new Promise<void>((resolve) => (observeStartedResolve = resolve));
    let releaseObserve!: () => void;
    const pendingObserve = new Promise<void>((resolve) => (releaseObserve = resolve));
    const target = { pid: 4242, windowId: 12345n };
    const host = await startTestHost({
      driver: "fake",
      target,
      idleTimeoutMs: 60_000,
      observeResult: async (signal) => {
        observeStartedResolve();
        await pendingObserve;
        if (signal?.aborted) {
          throw new Error("observe aborted");
        }
        return {
          id: randomUUID(),
          target,
          capturedAt: Date.now(),
          epoch: "final-observe",
          revision: 0,
          title: "fixture",
          ax: { status: "usable" as const, elements: [], total: 0, returned: 0, complete: true },
          image: { status: "unavailable" as const }
        };
      }
    });
    try {
      const request = host.batchRequest([{ kind: "key", key: "Return" }]);
      request.operation = {
        kind: "batch",
        request: { actions: [{ kind: "key", key: "Return" }], observe: { mode: "ax" } }
      };
      const running = host.send(request);
      await observeStarted;
      await sendControl(host.socketPath, {
        kind: "cancel",
        schemaVersion: 1,
        sessionId: host.sessionId,
        requestId: request.requestId
      }, 5_000);
      releaseObserve();
      const reply = await running;
      expect(reply.status).toBe("interrupted");
      expect((reply.result as { observationError?: { code?: string } }).observationError?.code).toBe("request_cancelled");
    } finally {
      releaseObserve();
      await host.close().catch(() => undefined);
      await host.cleanup();
    }
  });

  test("close is idempotent and reports the final state", async () => {
    const host = await startTestHost({ driver: "fake" });
    const first = await host.control("close");
    expect(first.info?.state).toMatch(/stopping|closed/);
    const finalInfo = await host.host.waitUntilClosed();
    expect(finalInfo.state).toBe("closed");
    await host.cleanup();
  });
});

describe("request dedup at the host (B3)", () => {
  test("state and request journals stay isolated under a shared production root", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "cu-shared-root-"));
    const first = await startTestHost({ driver: "fake", root, target: { pid: 4242, windowId: 12345n } });
    const second = await startTestHost({ driver: "fake", root, target: { pid: 4243, windowId: 12345n } });
    try {
      const one = await first.exec({ code: "state.n = 1; return state.n;" });
      const two = await second.exec({ code: "return state.n;" });
      expect(one.result.stateCommitted).toBe(true);
      expect(two.result.stateCommitted).toBe(true);
      expect(two.result.value).toBeNull();
      const sameIdDifferentSession = await second.send({
        ...second.batchRequest([{ kind: "key", key: "Return" }]),
        requestId: "shared-id"
      });
      expect(sameIdDifferentSession.status).toBe("completed");
      const other = await first.send({
        ...first.batchRequest([{ kind: "key", key: "Return" }]),
        requestId: "shared-id"
      });
      expect(other.status).toBe("completed");
      const { readFile } = await import("node:fs/promises");
      const firstEvents = await readFile(join(first.root, first.sessionId, "requests", "shared-id", "events.jsonl"), "utf8");
      const secondEvents = await readFile(join(second.root, second.sessionId, "requests", "shared-id", "events.jsonl"), "utf8");
      expect(firstEvents).toContain('"type":"action_started"');
      expect(secondEvents).toContain('"type":"action_started"');
      expect(firstEvents).not.toBe(secondEvents);
    } finally {
      await first.close();
      await second.close();
      await first.cleanup();
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test("an interrupted batch with an unknown receipt becomes an unknown session reply", async () => {
    const host = await startTestHost({
      driver: "fake",
      batchResult: () => ({
        status: "interrupted",
        steps: [{ index: 0, kind: "key", status: "unknown", error: { code: "late", message: "delivery unknown" } }]
      })
    });
    try {
      const reply = await host.batch({ actions: [{ kind: "key", key: "Return" }] });
      expect(reply.status).toBe("unknown");
      expect((reply.result as { status: string }).status).toBe("interrupted");
      expect((await host.control("status")).info?.state).toMatch(/unusable|stopping/);
    } finally {
      await host.host.waitUntilClosed().catch(() => undefined);
      await host.cleanup();
    }
  });

  test("cancel closes admission before the delayed native call settles", async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => (release = resolve));
    const host = await startTestHost({
      driver: "fake",
      batchResult: async () => {
        await pending;
        return { status: "completed", steps: [{ index: 0, kind: "key", status: "delivered" }] };
      }
    });
    try {
      const request = host.batchRequest([{ kind: "key", key: "Return" }]);
      const first = host.send(request);
      await new Promise((resolve) => setTimeout(resolve, 30));
      const cancel = await sendControl(host.socketPath, {
        kind: "cancel",
        schemaVersion: 1,
        sessionId: host.sessionId,
        requestId: request.requestId
      }, 5_000);
      expect(cancel.info?.state).toMatch(/stopping|running/);
      release?.();
      await first.catch(() => undefined);
      expect((await host.control("status")).info?.state).toBe("idle");
      await host.close();
      expect((await host.host.waitUntilClosed()).state).toBe("closed");
    } finally {
      await host.host.waitUntilClosed().catch(() => undefined);
      await host.cleanup();
    }
  });

  test("a delayed native call blocks admission until it settles or the session is unusable", async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => (release = resolve));
    const host = await startTestHost({
      driver: "fake",
      batchResult: async () => {
        await pending;
        return { status: "completed", steps: [{ index: 0, kind: "key", status: "delivered" }] };
      }
    });
    try {
      const first = host.batch({ actions: [{ kind: "key", key: "Return" }] });
      await new Promise((resolve) => setTimeout(resolve, 30));
      const busy = await host.batch({ actions: [{ kind: "key", key: "Escape" }] });
      expect(busy.error?.code).toBe("session_busy");
      release?.();
      expect((await first).status).toBe("completed");
      const next = await host.batch({ actions: [{ kind: "key", key: "Tab" }] });
      expect(next.status).toBe("completed");
    } finally {
      await host.close();
      await host.cleanup();
    }
  });

  test("the same request-id runs exactly once; different content conflicts", async () => {
    const host = await startTestHost({ driver: "fake" });
    try {
      const request = host.batchRequest([{ kind: "key", key: "Return" }]);
      const first = await host.send(request);
      expect(first.status).toBe("completed");
      const second = await host.send({ ...request });
      expect(second.status).toBe("completed");
      expect((await host.diagnostics()).deliveries).toBe(1);
      const conflict = await host.send({
        ...request,
        operation: { kind: "batch", request: { actions: [{ kind: "key", key: "Escape" }] } as BatchRequest }
      });
      expect(conflict.error?.code).toBe("request_conflict");
    } finally {
      await host.close();
      await host.cleanup();
    }
  });

  test("unknown-delivery failures close the session as unusable (no replay)", async () => {
    const host = await startTestHost({
      driver: "fake",
      idleTimeoutMs: 60_000,
      batchError: { code: "command_timeout", message: "native call timed out" }
    });
    const requestId = `req-${randomUUID()}`;
    try {
      const reply = await host.send({
        schemaVersion: 1,
        sessionId: host.sessionId,
        generation: host.generation,
        requestId,
        operation: {
          kind: "batch",
          request: { actions: [{ kind: "key", key: "Return" }] }
        }
      });
      expect(reply.status).toBe("unknown");
      expect(reply.error?.code).toBe("command_timeout");
      // the session is unusable and cannot accept more work
      const followUp = await host.batch({ actions: [{ kind: "key", key: "X" }] });
      expect(followUp.error?.code).toMatch(/session_closed|session_unusable/);
      // a retry of the same request reads the terminal unknown state
      const retry = await host.send({
        schemaVersion: 1,
        sessionId: host.sessionId,
        generation: host.generation,
        requestId,
        operation: {
          kind: "batch",
          request: { actions: [{ kind: "key", key: "Return" }] }
        }
      });
      expect(retry.status).toBe("unknown");
    } finally {
      await host.host.waitUntilClosed().catch(() => undefined);
      await host.cleanup();
    }
  });
});
