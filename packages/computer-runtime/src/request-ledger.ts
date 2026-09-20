import { createJournalWriter, type RequestJournal, type RequestStatus } from "./request-journal.js";

export interface RequestOutcome {
  status: Exclude<RequestStatus, "running">;
  result?: unknown;
  error?: { code: string; message: string };
}

/** One owner for request persistence and its live projection. A failed write
 * leaves the request unresolved; a terminal result becomes reusable only
 * after its event is stored. All entrypoints use the same ordering. */
export function createRequestLedger(journal: RequestJournal) {
  const append = createJournalWriter(journal);
  const outcomes = new Map<string, RequestOutcome>();
  const unresolved = new Set<string>();
  const acceptCommitted = (id: string, outcome: RequestOutcome): void => {
    outcomes.set(id, outcome);
    unresolved.delete(id);
  };
  return {
    acceptCommitted,
    append,
    read: (id: string) => journal.read(id),
    async claim(id: string, hash: string) {
      const claim = await journal.claim(id, hash);
      if (claim === "new") unresolved.add(id);
      return claim;
    },
    cached: (id: string) => outcomes.get(id),
    get unresolvedIds() { return [...unresolved]; },
    async finish(id: string, outcome: RequestOutcome, extra: Record<string, unknown> = {}) {
      await append(id, "request_finished", { ...extra, ...outcome });
      acceptCommitted(id, outcome);
    },
    fail(id: string, error: RequestOutcome["error"]) {
      unresolved.add(id);
      outcomes.set(id, { status: "unknown", error });
    }
  };
}
