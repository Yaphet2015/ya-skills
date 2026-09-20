import { expect, test } from "bun:test";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { startTestHost } from "./helpers/session-worker.js";
import type { SessionRequest } from "../packages/computer-session/src/types.js";
import { createRequestJournal } from "@ya-skills/computer-runtime";

test("an atomic exec commit survives a missing terminal journal projection without replay", async () => {
  const first = await startTestHost({ driver: "fake", target: { pid: 900_000 + process.pid, windowId: 1n } });
  const request: SessionRequest = {
    schemaVersion: 1, sessionId: first.sessionId, generation: first.generation,
    requestId: "atomic-result",
    operation: { kind: "exec", code: "state.n = 1; return state.n;", sourceName: "script.js", timeoutMs: 5_000, maxActions: 1 }
  };
  let reopened: Awaited<ReturnType<typeof startTestHost>> | undefined;
  try {
    const original = await first.send(request);
    expect(original.status).toBe("completed");
    expect((original.result as { stateCommitted: boolean }).stateCommitted).toBe(true);
    await first.close();

    // Simulate a crash after the transaction commit but before event/snapshot
    // projection. The immutable transaction is the only completed proof left.
    const sessionDir = join(first.root, first.sessionId);
    const eventsPath = join(sessionDir, "requests", request.requestId, "events.jsonl");
    const events = (await readFile(eventsPath, "utf8")).trimEnd().split("\n")
      .filter((line) => JSON.parse(line).type !== "request_finished");
    await writeFile(eventsPath, `${events.join("\n")}\n`);
    await rm(join(sessionDir, "state", "state.json"));
    await rm(join(sessionDir, "state", "history"), { recursive: true, force: true });

    reopened = await startTestHost({
      driver: "fake", root: first.root, sessionId: first.sessionId, generation: first.generation,
      target: { pid: first.target.pid, windowId: BigInt(first.target.windowId) }
    });
    const duplicate = await reopened.send(request);
    expect(duplicate).toEqual(original);
    expect(reopened.fakeCalls).toEqual([]);

    await rm(join(sessionDir, "requests", request.requestId), { recursive: true });
    expect(await reopened.send(request)).toEqual(original);
    const conflict = await reopened.send({ ...request, operation: { kind: "exec", code: "state.n = 99;", sourceName: "script.js", timeoutMs: 5_000, maxActions: 1 } });
    expect(conflict.error?.code).toBe("request_conflict");
    expect(reopened.fakeCalls).toEqual([]);

    const next = await reopened.send({
      ...request, requestId: "after-recovery",
      operation: { kind: "exec", code: "state.n += 1; return state.n;", sourceName: "script.js", timeoutMs: 5_000, maxActions: 1 }
    });
    expect(next.status).toBe("completed");
    expect((next.result as { value: number; stateVersion: number }).value).toBe(2);
    expect((next.result as { stateVersion: number }).stateVersion).toBe(2);
  } finally {
    await reopened?.close().catch(() => undefined);
    await first.close().catch(() => undefined);
    await first.cleanup();
  }
}, 30_000);

test("a terminal journal failure cannot erase an atomic exec result in the live host", async () => {
  const host = await startTestHost({
    driver: "fake", target: { pid: 910_000 + process.pid, windowId: 1n },
    journal: (config) => {
      const journal = createRequestJournal(join(config.root, config.sessionId, "requests"));
      return { ...journal, async append(id, event) {
        if (event.type === "request_finished") throw new Error("injected projection failure");
        await journal.append(id, event);
      } };
    }
  });
  try {
    const request: SessionRequest = {
      schemaVersion: 1, sessionId: host.sessionId, generation: host.generation, requestId: "journal-failure",
      operation: { kind: "exec", code: "state.n = 1; return state.n;", sourceName: "script.js", timeoutMs: 5_000, maxActions: 1 }
    };
    const original = await host.send(request);
    expect(original.status).toBe("completed");
    expect((original.result as { stateCommitted: boolean }).stateCommitted).toBe(true);
    expect(await host.send(request)).toEqual(original);
    expect(host.host.info().state).toBe("idle");
  } finally {
    await host.close().catch(() => undefined);
    await host.cleanup();
  }
}, 30_000);
