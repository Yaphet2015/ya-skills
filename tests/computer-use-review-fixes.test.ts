import { describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  acquireTargetLease,
  LeaseError,
  processStartTime
} from "../packages/computer-runtime/src/target-lease.js";
import { createSessionWithBackend, type MutationLeases } from "../packages/computer-runtime/src/session.js";
import { fakeBackendFactory } from "./helpers/computer-fixtures.js";
import {
  createRequestJournal,
  type RequestEvent
} from "../packages/computer-runtime/src/request-journal.js";
import { FrameReader, encodeRequest } from "../packages/computer-session/src/protocol.js";
import { sendControl } from "../packages/computer-session/src/client.js";
import { startTestHost } from "./helpers/session-worker.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error("condition did not become true"));
      setTimeout(poll, 5);
    };
    poll();
  });
}

describe("review-fix regressions: host admission and cancellation", () => {
  test("two business frames in one socket chunk reserve only one hosted batch", async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const host = await startTestHost({
      driver: "fake",
      idleTimeoutMs: 60_000,
      batchResult: async (request) => {
        calls++;
        await held;
        return {
          status: "completed",
          steps: request.actions.map((action, index) => ({ index, kind: action.kind, status: "delivered" }))
        };
      }
    });
    const replies: string[] = [];
    const reader = new FrameReader();
    const socket = connect(host.socketPath);
    socket.on("data", (chunk: Buffer) => replies.push(...reader.push(chunk)));
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", () => {
          const one = host.batchRequest([{ kind: "key", key: "Return" }]);
          const two = host.batchRequest([{ kind: "key", key: "Escape" }]);
          socket.write(encodeRequest(one) + encodeRequest(two));
          resolve();
        });
        socket.once("error", reject);
      });
      await waitUntil(() => calls > 0);
      await sleep(50);
      expect(calls).toBe(1);
      release?.();
      await waitUntil(() => replies.length === 2);
      const parsed = replies.map((line) => JSON.parse(line) as { status: string; error?: { code: string } });
      expect(parsed.map((reply) => reply.status).sort()).toEqual(["completed", "failed"]);
      expect(parsed.find((reply) => reply.error)?.error?.code).toBe("session_busy");
    } finally {
      release?.();
      socket.destroy();
      await host.close().catch(() => undefined);
      await host.cleanup();
    }
  }, 30_000);

  test("a hosted batch durably acknowledges each action before the next dispatch", async () => {
    let calls = 0;
    let firstOutcomeVisible = false;
    const host = await startTestHost({
      driver: "fake",
      idleTimeoutMs: 60_000,
      batchResult: async (request) => {
        calls++;
        if (calls === 2) {
          const events = await readFile(join(host.root, host.sessionId, "requests", "req-1", "events.jsonl"), "utf8");
          firstOutcomeVisible = events.includes('"type":"action_finished"') && events.includes('"index":0');
        }
        return {
          status: "completed",
          steps: request.actions.map((action, index) => ({ index, kind: action.kind, status: "delivered" }))
        };
      }
    });
    try {
      const result = await host.batch({ actions: [{ kind: "key", key: "A" }, { kind: "key", key: "B" }] });
      expect(result.status).toBe("completed");
      expect(calls).toBe(2);
      expect(firstOutcomeVisible).toBe(true);
    } finally {
      await host.close();
      await host.cleanup();
    }
  });

  test("cancelling a hosted multi-action batch stops undispatched actions", async () => {
    const started: string[] = [];
    const host = await startTestHost({
      driver: "fake",
      idleTimeoutMs: 60_000,
      batchResult: async (request, signal) => {
        for (const action of request.actions) {
          started.push(action.kind);
          await sleep(100);
          if (signal?.aborted) {
            return {
              status: "interrupted",
              steps: [{ index: 0, kind: action.kind, status: "delivered" }]
            };
          }
        }
        return {
          status: "completed",
          steps: request.actions.map((action, index) => ({ index, kind: action.kind, status: "delivered" }))
        };
      }
    });
    try {
      const request = host.batchRequest([
        { kind: "key", key: "A" },
        { kind: "key", key: "B" },
        { kind: "key", key: "C" }
      ]);
      const running = host.send(request);
      await waitUntil(() => started.length === 1);
      const cancelled = await sendControl(host.socketPath, {
        kind: "cancel",
        schemaVersion: 1,
        sessionId: host.sessionId,
        requestId: request.requestId
      }, 5_000);
      expect(cancelled.info?.state).toMatch(/running|idle|stopping/);
      const reply = await running;
      expect(reply.status).not.toBe("completed");
      expect(started.length).toBe(1);
    } finally {
      await host.close().catch(() => undefined);
      await host.cleanup();
    }
  }, 30_000);
});

describe("review-fix regressions: conservative lock recovery", () => {
  test("a stale reclamation lock fails closed instead of unlinking a lock read earlier", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const root = await mkdtemp(join(tmpdir(), "cu-stale-reclaim-"));
    const target = { pid: 4_000_001, windowId: 1n };
    const deadOwner = {
      generation: randomUUID(),
      pid: 4_000_001,
      kind: "session" as const
    };
    try {
      await mkdir(join(root, "leases"), { recursive: true });
      const leasePath = join(root, "leases", `app-${target.pid}.lease`);
      await writeFile(leasePath, JSON.stringify(deadOwner));
      await writeFile(`${leasePath}.reclaim-lock`, JSON.stringify({
        generation: `lock-${deadOwner.generation}`,
        pid: 4_000_001,
        kind: "session"
      }));
      const next = {
        generation: randomUUID(),
        pid: process.pid,
        processStart: processStartTime(process.pid),
        kind: "session" as const
      };
      const error = await acquireTargetLease(root, target, next).then(() => null, (value: unknown) => value);
      expect(error).toBeInstanceOf(LeaseError);
      expect((error as LeaseError).code).toBe("owner_identity_unknown");
      expect(await readFile(`${leasePath}.reclaim-lock`, "utf8").then(() => true, () => false)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("review-fix regressions: journal recovery ownership", () => {
  test("a recovery-lock loser does not append a terminal event", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const root = await mkdtemp(join(tmpdir(), "cu-recovery-loser-"));
    const journal = createRequestJournal(root);
    try {
      await journal.claim("dead", "hash");
      const started: RequestEvent = {
        seq: 0,
        time: Date.now(),
        type: "request_started",
        payload: { kind: "batch" }
      };
      await journal.append("dead", started);
      const requestDir = join(root, "dead");
      await writeFile(join(requestDir, "writer.json"), JSON.stringify({ pid: 4_000_001, time: Date.now() }));
      await writeFile(join(requestDir, "recovery.lock"), JSON.stringify({ pid: 4_000_001, time: Date.now() }));
      const error = await journal.read("dead").then(() => null, (value: unknown) => value);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/recovery|owner_identity/);
      const events = await readFile(join(requestDir, "events.jsonl"), "utf8");
      expect(events).not.toContain("request_finished");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("review-fix regressions: runtime admission", () => {
  test("a lease wait that expires before dispatch does not call the backend", async () => {
    let dispatched = 0;
    let released = 0;
    const leases: MutationLeases = {
      acquire: async () => {
        await sleep(75);
        return {
          owner: () => ({ generation: "g", pid: process.pid, kind: "single-step" as const }),
          refreshOwner: async () => undefined,
          release: async () => { released++; }
        };
      }
    };
    const session = createSessionWithBackend(
      {
        load: async () => ({}),
        create: fakeBackendFactory({
          type: async () => { dispatched++; return { isError: false }; }
        })
      },
      { leases, deadlineAt: Date.now() + 20 }
    );
    try {
      const error = await session.computer.type({ pid: 4242, windowId: 12345n }, "late").then(() => null, (value: unknown) => value);
      expect(error).toBeInstanceOf(Error);
      expect((error as { code?: string }).code).toBe("command_timeout");
      expect(dispatched).toBe(0);
    } finally {
      await session.close().catch(() => undefined);
      expect(released).toBe(1);
    }
  });
});

describe("review-fix regressions: exec state, output, and delivery", () => {
  test("a caught driver-worker loss cannot commit state or report completion", async () => {
    const host = await startTestHost({
      driver: "fake",
      batchError: { code: "driver_worker_exited", message: "worker exited" },
      batchErrorOutcome: undefined,
      idleTimeoutMs: 60_000
    });
    try {
      const result = await host.exec({
        code: "try { await computer.key('Return'); } catch { state.afterLoss = true; } return 1;"
      });
      expect(result.result.status).toBe("unknown");
      expect(result.result.stateCommitted).toBe(false);
      expect(result.reply.status).toBe("unknown");
    } finally {
      await host.host.waitUntilClosed().catch(() => undefined);
      await host.cleanup();
    }
  }, 30_000);

  test("a late unknown receipt reconciles an already-terminal unawaited result", async () => {
    const host = await startTestHost({
      driver: "fake",
      idleTimeoutMs: 60_000,
      batchResult: async () => {
        await sleep(150);
        throw new Error("driver_worker_exited");
      }
    });
    try {
      const result = await host.exec({
        code: "void computer.key('Return'); return 1;",
        timeoutMs: 2_000
      });
      expect(result.result.status).toBe("unknown");
      expect(result.result.stateCommitted).toBe(false);
      expect(result.result.error?.code).toMatch(/unknown|driver/);
    } finally {
      await host.host.waitUntilClosed().catch(() => undefined);
      await host.cleanup();
    }
  }, 30_000);

  test("state remains committed factually when the final observation times out", async () => {
    const host = await startTestHost({
      driver: "fake",
      idleTimeoutMs: 60_000,
      observeDelayMs: 1_500
    });
    try {
      const result = await host.exec({ code: "state.n = 1; return 1;", timeoutMs: 1_000 });
      expect(result.result.status).toBe("failed");
      expect(result.result.error?.code).toBe("final_observe_failed");
      expect(result.result.stateCommitted).toBe(true);
      expect(result.result.stateVersion).toBe(1);
      const state = JSON.parse(await readFile(join(host.root, host.sessionId, "state", "state.json"), "utf8")) as { version: number; value: { n: number } };
      expect(state.version).toBe(1);
      expect(state.value.n).toBe(1);
      const events = await readFile(join(host.root, host.sessionId, "requests", "req-1", "events.jsonl"), "utf8");
      expect(events).toContain('"type":"state_commit_intent"');
      expect(events).toContain('"stateHash"');
    } finally {
      await host.close().catch(() => undefined);
      await host.cleanup();
    }
  }, 30_000);

  test("twenty observations followed by a mutation fail instead of dropping fresh final evidence", async () => {
    const host = await startTestHost({ driver: "fake", idleTimeoutMs: 60_000 });
    try {
      const result = await host.exec({
        code: "for (let i = 0; i < 20; i++) await computer.observe({mode:'ax'}); await computer.key('Return'); return 1;",
        maxActions: 25,
        timeoutMs: 10_000
      });
      expect(result.result.status).toBe("failed");
      expect(result.result.error?.code).toBe("observation_limit");
      expect(result.result.observations?.length).toBe(20);
      expect(result.result.actions?.map((action) => action.status)).toContain("delivered");
    } finally {
      await host.close().catch(() => undefined);
      await host.cleanup();
    }
  }, 30_000);

  test("multiple individually valid observations cannot exceed the aggregate result budget", async () => {
    const host = await startTestHost({
      driver: "fake",
      idleTimeoutMs: 60_000,
      observeElementLabelBytes: 140_000
    });
    try {
      const result = await host.exec({
        code: "for (let i = 0; i < 10; i++) await computer.observe({mode:'ax'}); state.done = true; return 1;",
        maxActions: 20,
        timeoutMs: 20_000
      });
      expect(result.result.status).toBe("failed");
      expect(result.result.error?.code).toBe("result_limit");
      expect(result.result.stateCommitted).toBe(false);
      expect(result.result.actions).toEqual([]);
      expect((await host.control("status")).info?.state).toMatch(/idle|running/);
    } finally {
      await host.close().catch(() => undefined);
      await host.cleanup();
    }
  }, 60_000);
});
