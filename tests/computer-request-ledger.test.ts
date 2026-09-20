import { expect, test } from "bun:test";
import { createRequestLedger } from "../packages/computer-runtime/src/request-ledger.js";
import type { RequestEvent, RequestJournal } from "../packages/computer-runtime/src/request-journal.js";

test("a terminal write failure never caches success and a later write reuses the sequence", async () => {
  const events: RequestEvent[] = [];
  let rejectTerminal = true;
  const journal: RequestJournal = {
    claim: async () => "new",
    append: async (_id, event) => {
      if (event.type === "request_finished" && rejectTerminal) throw new Error("disk full");
      events.push(event);
    },
    read: async () => ({ hash: "h", status: "running", events }),
    list: async () => []
  };
  const ledger = createRequestLedger(journal);
  await ledger.claim("r", "h");
  await ledger.append("r", "request_started", { kind: "batch" });
  await expect(ledger.finish("r", { status: "completed", result: 1 })).rejects.toThrow("disk full");
  expect(ledger.cached("r")).toBeUndefined();
  expect(ledger.unresolvedIds).toEqual(["r"]);
  ledger.fail("r", { code: "journal_error", message: "disk full" });
  expect(ledger.cached("r")?.status).toBe("unknown");
  rejectTerminal = false;
  await ledger.finish("r", { status: "unknown", error: { code: "journal_error", message: "disk full" } });
  expect(events.map((event) => event.seq)).toEqual([0, 1]);
  expect(ledger.unresolvedIds).toEqual([]);
});
