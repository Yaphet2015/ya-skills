import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequestJournal, createJournalWriter, canonicalRequestHash } from "../packages/computer-runtime/src/request-journal.js";

async function makeJournal() {
  const root = await mkdtemp(join(tmpdir(), "cu-journal-"));
  return { journal: createRequestJournal(root), root };
}

function startedEvent(seq: number) {
  return { seq, time: Date.now(), type: "request_started" as const, payload: { request: { actions: 1 } } };
}

describe("RequestJournal", () => {
  test("the first claim wins; the same id+hash replays nothing, a different hash conflicts", async () => {
    const { journal, root } = await makeJournal();
    const id = "req-1";
    const hash = canonicalRequestHash({ kind: "batch", target: { pid: 1, windowId: "2" }, operation: { a: 1 } });
    expect(await journal.claim(id, hash)).toBe("new");
    expect(await journal.claim(id, hash)).toBe("existing");
    const other = canonicalRequestHash({ kind: "batch", target: { pid: 1, windowId: "2" }, operation: { a: 2 } });
    expect(await journal.claim(id, other)).toBe("conflict");
    await rm(root, { recursive: true, force: true });
  });

  test("two journal instances (like two processes) agree on ownership", async () => {
    const { journal, root } = await makeJournal();
    const second = createRequestJournal(root);
    const hash = "h1";
    expect(await journal.claim("req-2", hash)).toBe("new");
    expect(await second.claim("req-2", hash)).toBe("existing");
    await rm(root, { recursive: true, force: true });
  });

  test("events append with strict sequences; a gap fails loud", async () => {
    const { journal, root } = await makeJournal();
    await journal.claim("req-3", "h");
    await journal.append("req-3", startedEvent(0));
    await journal.append("req-3", { seq: 1, time: Date.now(), type: "request_finished", payload: { status: "completed", result: { ok: 1 } } });
    const record = await journal.read("req-3");
    expect(record.status).toBe("completed");
    expect(record.result).toEqual({ ok: 1 });
    await expect(journal.append("req-3", { seq: 5, time: Date.now(), type: "action_started", payload: {} })).rejects.toThrow(/sequence gap/);
    await rm(root, { recursive: true, force: true });
  });

  test("a started-without-finished record reads as running (crash view is the host's call)", async () => {
    const { journal, root } = await makeJournal();
    await journal.claim("req-4", "h");
    await journal.append("req-4", startedEvent(0));
    await journal.append("req-4", { seq: 1, time: Date.now(), type: "action_started", payload: { kind: "type" } });
    const record = await journal.read("req-4");
    expect(record.status).toBe("running");
    await rm(root, { recursive: true, force: true });
  });

  test("a truncated tail line fails loud, never silently succeeds", async () => {
    const { journal, root } = await makeJournal();
    await journal.claim("req-5", "h");
    await journal.append("req-5", startedEvent(0));
    const eventsFile = join(root, "req-5", "events.jsonl");
    await writeFile(eventsFile, (await readFile(eventsFile, "utf8")) + '{"seq":1,"time":123,"type":"request_fin');
    await expect(journal.read("req-5")).rejects.toThrow(/truncated|not valid JSON/);
    await rm(root, { recursive: true, force: true });
  });

  test("invalid event types and payloads are rejected on append", async () => {
    const { journal, root } = await makeJournal();
    await journal.claim("req-6", "h");
    await expect(
      journal.append("req-6", { seq: 0, time: Date.now(), type: "mischief" as never, payload: {} })
    ).rejects.toThrow(/type/);
    await expect(
      journal.append("req-6", { seq: 0, time: Date.now(), type: "request_started", payload: "not-an-object" as never })
    ).rejects.toThrow(/payload/);
    await rm(root, { recursive: true, force: true });
  });

  test("terminal observations with bigint window ids are serialized without losing the record", async () => {
    const { journal, root } = await makeJournal();
    await journal.claim("req-bigint", "h");
    await journal.append("req-bigint", startedEvent(0));
    await journal.append("req-bigint", {
      seq: 1,
      time: Date.now(),
      type: "request_finished",
      payload: {
        status: "completed",
        result: { target: { pid: 7, windowId: 9007199254740993n }, observations: [{ title: "你好" }] }
      }
    });
    const record = await journal.read("req-bigint");
    expect(record.status).toBe("completed");
    expect(record.result).toEqual({ target: { pid: 7, windowId: "9007199254740993" }, observations: [{ title: "你好" }] });
    await rm(root, { recursive: true, force: true });
  });

  test("reading an unknown request fails loud", async () => {
    const { journal, root } = await makeJournal();
    await expect(journal.read("never-claimed")).rejects.toThrow(/no journal record/);
    await rm(root, { recursive: true, force: true });
  });
});

describe("canonicalRequestHash", () => {
  test("operation content decides the hash; transport identity does not", () => {
    const target = { pid: 1, windowId: "2" };
    const a = canonicalRequestHash({ kind: "batch", target, operation: { actions: [{ kind: "key", key: "Return" }] } });
    const b = canonicalRequestHash({ kind: "batch", target, operation: { actions: [{ kind: "key", key: "Return" }] } });
    const c = canonicalRequestHash({ kind: "batch", target, operation: { actions: [{ kind: "key", key: "Escape" }] } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  test("bigint and string windowIds hash identically", () => {
    const a = canonicalRequestHash({ kind: "exec", target: { pid: 1, windowId: 123n }, operation: { code: "1" } });
    const b = canonicalRequestHash({ kind: "exec", target: { pid: 1, windowId: "123" }, operation: { code: "1" } });
    expect(a).toBe(b);
  });
});


test("journal writer serializes a request and retries failed persistence without a sequence gap", async () => {
  const events: Array<{ id: string; seq: number }> = [];
  let rejectFirst = true;
  const write = createJournalWriter({
    async append(id, event) {
      await Promise.resolve();
      if (rejectFirst) { rejectFirst = false; throw new Error("disk full"); }
      events.push({ id, seq: event.seq });
    }
  });
  const first = write("a", "request_started", {});
  const second = write("a", "request_started", {});
  await expect(first).rejects.toThrow("disk full");
  await second;
  await Promise.all([
    write("a", "action_started", {}),
    write("a", "action_finished", {}),
    write("b", "request_started", {})
  ]);
  expect(events.filter((e) => e.id === "a").map((e) => e.seq)).toEqual([0, 1, 2]);
  expect(events.filter((e) => e.id === "b").map((e) => e.seq)).toEqual([0]);
});
