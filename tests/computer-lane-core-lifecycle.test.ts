import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  acquireTargetLease,
  LeaseError,
  createRequestJournal,
  processStartTime
} from "../packages/computer-runtime/src/index.js";
import { commitExecState, execStateHash } from "../packages/computer-session/src/exec-state.js";
import { openSession } from "../packages/computer-session/src/open.js";
import { sessionPaths } from "../packages/computer-session/src/paths.js";
import { stopProcessGroup } from "../packages/computer-session/src/process.js";
import { sendControl, sendRequest } from "../packages/computer-session/src/client.js";
import { startTestHost } from "./helpers/session-worker.js";
import type { SessionRequest } from "../packages/computer-session/src/types.js";
import type { BatchRequest, Target } from "@ya-skills/computer-runtime";

let targetCounter = 0;
function uniqueTarget(): Target {
  targetCounter += 1;
  return { pid: 700_000 + process.pid + targetCounter, windowId: BigInt(10_000 + targetCounter) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition did not become true");
    await sleep(10);
  }
}

function keyBatch(keys: string[], timeoutMs?: number): BatchRequest {
  return {
    actions: keys.map((key) => ({ kind: "key", key })),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    maxActions: Math.max(1, keys.length)
  };
}

describe("core lifecycle lane: exec admission and receipts", () => {
  test("exec inner batch stops after its absolute deadline and retains not_run receipts", async () => {
    let batchCalls = 0;
    const host = await startTestHost({
      driver: "fake",
      target: uniqueTarget(),
      idleTimeoutMs: 60_000,
      batchResult: async (request) => {
        batchCalls += 1;
        if ((request.actions[0] as { kind: string; key?: string }).key === "A") await sleep(180);
        return {
          status: "completed",
          steps: request.actions.map((action, index) => ({ index, kind: action.kind, status: "delivered" as const }))
        };
      }
    });
    try {
      const result = await host.exec({
        code: "return await computer.batch({actions:[{kind:'key',key:'A'},{kind:'key',key:'B'},{kind:'key',key:'C'}],timeoutMs:80,maxActions:3});",
        timeoutMs: 2_000,
        maxActions: 3
      });
      expect(batchCalls).toBe(1);
      expect(result.result.actions.map((receipt) => receipt.status)).toEqual(["delivered", "not_run", "not_run"]);
      expect(result.result.actions.map((receipt) => receipt.index)).toEqual([0, 1, 2]);
    } finally {
      await host.close().catch(() => undefined);
      await host.cleanup();
    }
  }, 30_000);

  test("an unawaited inner batch cannot dispatch its later steps", async () => {
    let batchCalls = 0;
    const host = await startTestHost({
      driver: "fake",
      target: uniqueTarget(),
      idleTimeoutMs: 60_000,
      batchResult: async (request) => {
        batchCalls += 1;
        await sleep(120);
        return {
          status: "completed",
          steps: request.actions.map((action, index) => ({ index, kind: action.kind, status: "delivered" as const }))
        };
      }
    });
    try {
      const result = await host.exec({
        code: "void computer.batch({actions:[{kind:'key',key:'A'},{kind:'key',key:'B'}],maxActions:2}); return 1;",
        timeoutMs: 2_000,
        maxActions: 2
      });
      expect(batchCalls).toBeLessThanOrEqual(1);
      expect(result.result.actions).toHaveLength(2);
      expect(result.result.actions[1]?.status).toBe("not_run");
      expect(result.result.actions.map((receipt) => receipt.index)).toEqual([0, 1]);
      expect(result.result.stateCommitted).toBe(false);
    } finally {
      await host.close().catch(() => undefined);
      await host.cleanup();
    }
  }, 30_000);

  test("aggregate overflow preserves unknown severity and the dispatched receipt", async () => {
    const host = await startTestHost({
      driver: "fake",
      target: uniqueTarget(),
      idleTimeoutMs: 60_000,
      observeElementLabelBytes: 140_000,
      batchResult: async () => {
        throw new Error("separate driver disappeared after the known observations");
      }
    });
    try {
      const result = await host.exec({
        code: "for (let i=0;i<10;i++) await computer.observe({mode:'ax'}); await computer.key('Return'); return 1;",
        timeoutMs: 5_000,
        maxActions: 20
      });
      expect(result.reply.status).toBe("unknown");
      expect(result.result.status).toBe("unknown");
      expect(result.result.stateCommitted).toBe(false);
      expect(result.result.actions).toHaveLength(1);
      expect(result.result.actions[0]?.status).toBe("unknown");
      expect(result.result.observations).toHaveLength(0);
      expect(result.result.observationsDropped).toBe(10);
      expect((await host.control("status")).info?.state).toBe("unusable");
    } finally {
      await host.close().catch(() => undefined);
      await host.cleanup();
    }
  }, 30_000);

  test("batch observations share the exec observation cap", async () => {
    const host = await startTestHost({ driver: "fake", target: uniqueTarget(), idleTimeoutMs: 60_000 });
    try {
      const result = await host.exec({
        code: "for (let i=0;i<21;i++) await computer.batch({actions:[{kind:'key',key:'A'}],maxActions:1,observe:{mode:'ax'}}); return 1;",
        timeoutMs: 10_000,
        maxActions: 30
      });
      expect(result.result.status).toBe("failed");
      expect(result.result.error?.code).toBe("observation_limit");
      expect(result.result.observations).toHaveLength(20);
      expect(result.result.actions).toHaveLength(21);
      expect(result.result.actions.every((receipt) => receipt.status === "delivered")).toBe(true);
      expect(result.result.stateCommitted).toBe(false);
    } finally {
      await host.close().catch(() => undefined);
      await host.cleanup();
    }
  }, 30_000);

  test("mixed single and batch failures retain one run-level receipt per action", async () => {
    const host = await startTestHost({
      driver: "fake",
      target: uniqueTarget(),
      idleTimeoutMs: 60_000,
      batchResult: async (request) => {
        const key = (request.actions[0] as { key?: string }).key;
        if (key === "B") {
          return { status: "failed", steps: [{ index: 0, kind: "key", status: "not_delivered" as const, error: { code: "refused", message: "fixture refusal" } }] };
        }
        return { status: "completed", steps: [{ index: 0, kind: request.actions[0]!.kind, status: "delivered" as const }] };
      }
    });
    try {
      const result = await host.exec({
        code: "await computer.key('A'); return await computer.batch({actions:[{kind:'key',key:'B'},{kind:'key',key:'C'}],maxActions:2});",
        timeoutMs: 5_000,
        maxActions: 3
      });
      expect(result.result.actions.map((receipt) => receipt.index)).toEqual([0, 1, 2]);
      expect(result.result.actions.map((receipt) => receipt.status)).toEqual(["delivered", "not_delivered", "not_run"]);
    } finally {
      await host.close().catch(() => undefined);
      await host.cleanup();
    }
  }, 30_000);

  test("cancellation during final observation prevents state commit", async () => {
    const host = await startTestHost({ driver: "fake", target: uniqueTarget(), idleTimeoutMs: 60_000, observeDelayMs: 800 });
    const request: SessionRequest = {
      schemaVersion: 1,
      sessionId: host.sessionId,
      generation: host.generation,
      requestId: "final-cancel",
      operation: { kind: "exec", code: "state.cancelled = true; return 1;", sourceName: "script.js", timeoutMs: 5_000, maxActions: 1 }
    };
    try {
      const running = host.send(request);
      await waitUntil(() => host.fakeCalls.filter((call) => call === "observe").length > 0);
      await sendControl(host.socketPath, { kind: "cancel", schemaVersion: 1, sessionId: host.sessionId, requestId: request.requestId }, 5_000);
      const reply = await running;
      expect(reply.status).toBe("interrupted");
      expect((reply.result as { stateCommitted?: boolean }).stateCommitted).toBe(false);
      expect(existsSync(join(host.root, host.sessionId, "state", "state.json"))).toBe(false);
    } finally {
      await host.close().catch(() => undefined);
      await host.cleanup();
    }
  }, 30_000);
});

describe("core lifecycle lane: hosted deadlines and durable state", () => {
  test("hosted batches keep one deadline across journal, actions, and final admission", async () => {
    let batchCalls = 0;
    const host = await startTestHost({
      driver: "fake",
      target: uniqueTarget(),
      idleTimeoutMs: 60_000,
      batchResult: async (request) => {
        batchCalls += 1;
        await sleep(70);
        return { status: "completed", steps: [{ index: 0, kind: request.actions[0]!.kind, status: "delivered" as const }] };
      }
    });
    try {
      const reply = await host.batch(keyBatch(["A", "B", "C"], 100));
      const result = reply.result as { status: string; steps: Array<{ status: string }> };
      expect(batchCalls).toBe(2);
      expect(result.status).toBe("interrupted");
      expect(result.steps.map((step) => step.status)).toEqual(["delivered", "delivered", "not_run"]);
    } finally {
      await host.close().catch(() => undefined);
      await host.cleanup();
    }
  }, 30_000);

  test("historical exec replies remain verifiable after the state head advances", async () => {
    const root = await mkdtemp(join(tmpdir(), "cu-core-history-"));
    const sessionId = randomUUID();
    const generation = randomUUID();
    const target = uniqueTarget();
    const first = await startTestHost({ driver: "fake", root, sessionId, generation, target, idleTimeoutMs: 60_000 });
    try {
      const firstReply = await first.exec({ code: "state.n = 1; return state.n;", timeoutMs: 5_000, maxActions: 1 });
      expect(firstReply.result.stateVersion).toBe(1);
      await first.exec({ code: "state.n = 2; return state.n;", timeoutMs: 5_000, maxActions: 1 });
    } finally {
      await first.close().catch(() => undefined);
    }
    const reopened = await startTestHost({ driver: "fake", root, sessionId, generation, target, idleTimeoutMs: 60_000 });
    try {
      const retry = await reopened.send({
        schemaVersion: 1,
        sessionId,
        generation,
        requestId: "req-1",
        operation: { kind: "exec", code: "state.n = 1; return state.n;", sourceName: "script.js", timeoutMs: 5_000, maxActions: 1 }
      });
      expect(retry.status).toBe("completed");
      expect((retry.result as { stateVersion?: number }).stateVersion).toBe(1);
    } finally {
      await reopened.close().catch(() => undefined);
      await reopened.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("a crash after state rename is reconciled before the next admission", async () => {
    const host = await startTestHost({ driver: "fake", target: uniqueTarget(), idleTimeoutMs: 60_000 });
    const stateDir = join(host.root, host.sessionId, "state");
    const requestsDir = join(host.root, host.sessionId, "requests");
    const journal = createRequestJournal(requestsDir);
    try {
      const value = { recovered: true };
      commitExecState(stateDir, 0, value);
      await journal.claim("crashed-exec", "crash-hash");
      await journal.append("crashed-exec", { seq: 0, time: Date.now(), type: "request_started", payload: { kind: "exec" } });
      await journal.append("crashed-exec", {
        seq: 1,
        time: Date.now(),
        type: "state_commit_intent",
        payload: { expectedVersion: 0, version: 1, stateHash: execStateHash(value) }
      });
      await writeFile(join(requestsDir, "crashed-exec", "writer.json"), JSON.stringify({ pid: 4_000_123, time: Date.now() }));
      const reply = await host.batch({ actions: [{ kind: "key", key: "A" }] });
      expect(reply.status).toBe("completed");
      const recoveredEvents = await readFile(join(requestsDir, "crashed-exec", "events.jsonl"), "utf8");
      expect(recoveredEvents).toContain('"reason":"writer_gone"');
    } finally {
      await host.close().catch(() => undefined);
      await host.cleanup();
    }
  }, 30_000);
});

describe("core lifecycle lane: lease and host process boundaries", () => {
  test("a separate driver crash after the first known result preserves unknown and not_run receipts", async () => {
    const root = await mkdtemp(join(tmpdir(), "cu-core-driver-crash-"));
    const target = uniqueTarget();
    const driverModule = join(root, "driver.ts");
    await writeFile(driverModule, `
      let calls = 0;
      export default function () {
        return {
          async call(method, args) {
            if (method === "batch") {
              calls += 1;
              if (calls === 1) {
                return { status: "completed", steps: [{ index: 0, kind: args.request.actions[0].kind, status: "delivered" }] };
              }
              process.exit(71);
            }
            return null;
          },
          async close() {}
        };
      }
    `);
    let opened: Awaited<ReturnType<typeof openSession>> | undefined;
    try {
      opened = await openSession({ root, target, idleTimeoutMs: 60_000, driverModule: { path: driverModule } });
      const reply = await sendRequest(opened.socketPath, {
        schemaVersion: 1,
        sessionId: opened.info.id,
        generation: opened.info.generation,
        requestId: "driver-crash-after-first",
        operation: { kind: "batch", request: { actions: [{ kind: "key", key: "A" }, { kind: "key", key: "B" }, { kind: "key", key: "C" }], maxActions: 3 } }
      }, 15_000);
      const result = reply.result as { steps: Array<{ status: string; index: number }> };
      expect(reply.status).toBe("unknown");
      expect(result.steps.map((step) => step.status)).toEqual(["delivered", "unknown", "not_run"]);
      expect(result.steps.map((step) => step.index)).toEqual([0, 1, 2]);
    } finally {
      if (opened !== undefined) {
        await sendControl(opened.socketPath, { kind: "close", schemaVersion: 1, sessionId: opened.info.id }, 10_000).catch(() => undefined);
        await waitUntil(() => !existsSync(opened!.socketPath), 10_000).catch(() => undefined);
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("a failed cleanup group blocks reclamation after its dead leader and host", async () => {
    const root = await mkdtemp(join(tmpdir(), "cu-core-group-"));
    const target = uniqueTarget();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    try {
      await waitUntil(() => child.pid !== undefined);
      const holderPid = 4_000_000 + targetCounter;
      await writeFile(join(root, "holder.json"), "{}", { mode: 0o600 });
      await import("node:fs/promises").then(({ mkdir }) => mkdir(join(root, "leases"), { recursive: true }));
      const leasePath = join(root, "leases", `app-${target.pid}.lease`);
      await writeFile(leasePath, JSON.stringify({
        generation: randomUUID(),
        pid: holderPid,
        kind: "session",
        workerPids: [holderPid],
        workerGroups: [{ pgid: child.pid, leaderPid: holderPid }]
      }));
      const error = await acquireTargetLease(root, target, {
        generation: randomUUID(),
        pid: process.pid,
        processStart: processStartTime(process.pid),
        kind: "session"
      }).then(() => null, (value: unknown) => value);
      expect(error).toBeInstanceOf(LeaseError);
      expect((error as LeaseError).code).toBe("target_busy");
    } finally {
      await stopProcessGroup(child, 1_000).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("an unusable host closes its listener/path when explicitly finalized", async () => {
    const host = await startTestHost({
      driver: "fake",
      target: uniqueTarget(),
      idleTimeoutMs: 60_000,
      batchError: { code: "command_timeout", message: "fixture native timeout" }
    });
    try {
      const reply = await host.batch({ actions: [{ kind: "key", key: "A" }] });
      expect(reply.status).toBe("unknown");
      await host.host.waitUntilClosed();
      expect(existsSync(host.socketPath)).toBe(true);
      await host.close();
      expect(existsSync(host.socketPath)).toBe(false);
    } finally {
      await host.close().catch(() => undefined);
      await host.cleanup();
    }
  }, 30_000);

  test("standalone opener returns while its detached host remains usable", async () => {
    const root = await mkdtemp(join(tmpdir(), "cu-core-opener-"));
    const target = uniqueTarget();
    const modulePath = resolve(process.cwd(), "tests/helpers/session-worker.ts");
    const openPath = resolve(process.cwd(), "packages/computer-session/src/open.ts");
    const code = `
      import { openSession } from ${JSON.stringify(`file://${openPath}`)};
      const opened = await openSession({
        root: ${JSON.stringify(root)},
        target: { pid: ${target.pid}, windowId: ${target.windowId.toString()}n },
        driverModule: { path: ${JSON.stringify(modulePath)}, export: "createLaneFakeDriver" },
        idleTimeoutMs: 60000
      });
      console.log(JSON.stringify({ sessionId: opened.info.id, hostPid: opened.hostPid }));
    `;
    const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });
    let stdout = "";
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    });
    try {
      expect(exit.code).toBe(0);
      const opened = JSON.parse(stdout.trim()) as { sessionId: string; hostPid: number };
      expect(opened.hostPid).toBeGreaterThan(0);
      const paths = sessionPaths(root, opened.sessionId);
      expect(existsSync(paths.metadata)).toBe(true);
      const metadata = JSON.parse(await readFile(paths.metadata, "utf8")) as { generation: string };
      const socketPath = paths.socket;
      const status = await sendControl(socketPath, { kind: "status", schemaVersion: 1, sessionId: opened.sessionId }, 5_000);
      expect(status.info?.state).toBe("idle");
      await sendControl(socketPath, { kind: "close", schemaVersion: 1, sessionId: opened.sessionId }, 5_000);
      await waitUntil(() => !existsSync(socketPath));
      void metadata;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
