import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitExecState, loadExecState, validateJsonValue } from "../packages/computer-session/src/exec-state.js";
import { EXEC_MAX_STATE_BYTES } from "../packages/computer-session/src/exec-types.js";
import { createSessionLedger } from "../packages/computer-session/src/session-ledger.js";
import { startTestHost } from "./helpers/session-worker.js";

describe("validateJsonValue", () => {
  test("accepts plain JSON trees", () => {
    expect(validateJsonValue({ a: 1, b: [true, null, "x"], c: { d: 0.5 } }, 1024)).toEqual({
      a: 1,
      b: [true, null, "x"],
      c: { d: 0.5 }
    });
  });

  test.each([
    [Number.NaN, /finite/],
    [Number.POSITIVE_INFINITY, /finite/],
    [10n, /bigint/],
    [() => 1, /function/],
    [undefined, /undefined/],
    [Symbol("x"), /symbol/]
  ])("rejects %s state leaves", (value, pattern) => {
    expect(() => validateJsonValue({ value }, 1024)).toThrow(pattern as RegExp);
  });

  test("allows repeated acyclic references while still rejecting cycles", () => {
    const shared = { value: 1 };
    expect(validateJsonValue({ first: shared, second: shared }, 1_000)).toEqual({ first: { value: 1 }, second: { value: 1 } });
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => validateJsonValue(cyclic, 1_000)).toThrow(/circular/);
  });

  test("rejects circular references instead of hanging", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => validateJsonValue(a, 1024)).toThrow(/circular/);
  });

  test("enforces the byte budget", () => {
    expect(() => validateJsonValue({ big: "y".repeat(EXEC_MAX_STATE_BYTES) }, EXEC_MAX_STATE_BYTES)).toThrow(
      /bytes/
    );
  });

  test("does not silently drop undefined fields (stringify would)", () => {
    // JSON.stringify({a: undefined}) === "{}" — the validator must reject it
    // rather than committing a state the script never sees again.
    expect(() => validateJsonValue({ a: undefined }, 1024)).toThrow(/undefined/);
  });
});

describe("state file commit/load", () => {
  test("versions advance; stale writers conflict", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cu-state-"));
    try {
      expect(loadExecState(dir)).toEqual({ version: 0, value: {} });
      expect(commitExecState(dir, 0, { n: 1 })).toBe(1);
      expect(loadExecState(dir)).toEqual({ version: 1, value: { n: 1 } });
      expect(() => commitExecState(dir, 0, { n: 2 })).toThrow(/version conflict/);
      expect(commitExecState(dir, 1, { n: 3 })).toBe(2);
      expect(loadExecState(dir).value).toEqual({ n: 3 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("corrupt state files fail loud", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cu-state-"));
    const { writeFile } = await import("node:fs/promises");
    try {
      commitExecState(dir, 0, { n: 1 });
      await writeFile(join(dir, "state.json"), "{corrupt");
      expect(() => loadExecState(dir)).toThrow(/corrupt|JSON/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("session ledger commit/load", () => {
  function result() {
    return {
      status: "completed" as const,
      stateVersion: 0,
      stateCommitted: false,
      actions: [],
      observations: [],
      logs: []
    };
  }

  test("one immutable record owns the result and state, including historical versions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cu-ledger-"));
    try {
      const ledger = createSessionLedger(dir);
      const first = ledger.commitState("req-1", "hash-1", 0, { n: 1 }, result());
      expect(first.version).toBe(1);
      expect(first.result.stateCommitted).toBe(true);
      expect(ledger.read("req-1")?.result).toEqual(first.result);

      const duplicate = ledger.commitState("req-1", "hash-1", 0, { n: 1 }, result());
      expect(duplicate.record.recordHash).toBe(first.record.recordHash);
      expect(() => ledger.commitState("req-1", "hash-1", 0, { n: 2 }, result())).toThrow(/conflict/);

      const second = ledger.commitState("req-2", "hash-2", 1, { n: 2 }, result());
      expect(second.version).toBe(2);
      expect(ledger.readState()).toMatchObject({ version: 2, value: { n: 2 } });
      expect(ledger.readStateVersion(1)).toMatchObject({ version: 1, value: { n: 1 }, requestId: "req-1" });
      expect(ledger.verify("req-1", "hash-1")).toBe(true);
      expect(ledger.verify("req-1", "wrong-hash")).toBe(false);
      expect(() => ledger.commitState("req-3", "hash-3", 1, { n: 3 }, result())).toThrow(/version conflict/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("only completed or final-observation-failed results may commit state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cu-ledger-outcome-"));
    try {
      const ledger = createSessionLedger(dir);
      const rejected = [
        { ...result(), status: "interrupted" as const, error: { code: "request_cancelled", message: "cancelled" } },
        { ...result(), status: "unknown" as const, error: { code: "unknown_delivery", message: "unknown" } },
        { ...result(), status: "failed" as const, error: { code: "state_commit_failed", message: "failed" } }
      ];
      for (const [index, candidate] of rejected.entries()) {
        expect(() => ledger.commitState(`rejected-${index}`, `hash-${index}`, 0, { n: index }, candidate)).toThrow(
          /only completed exec results or failed final_observe_failed results may commit state/
        );
      }
      expect(ledger.readState()).toMatchObject({ version: 0, value: {} });

      const allowed = {
        ...result(),
        status: "failed" as const,
        error: { code: "final_observe_failed", message: "final observation failed" }
      };
      const committed = ledger.commitState("final-observe-failure", "hash-final", 0, { n: 1 }, allowed);
      expect(committed.result.status).toBe("failed");
      expect(committed.result.stateCommitted).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ledger records derive snapshots after cache removal, while corrupt cache stays fatal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cu-ledger-cache-"));
    try {
      const ledger = createSessionLedger(dir);
      ledger.commitState("req-cache", "hash-cache", 0, { n: 1 }, result());
      await rm(join(dir, "state.json"));
      await rm(join(dir, "history"), { recursive: true, force: true });
      expect(loadExecState(dir)).toEqual({ version: 1, value: { n: 1 } });

      await writeFile(join(dir, "state.json"), "{corrupt");
      expect(() => loadExecState(dir)).toThrow(/corrupt state file/);
      expect(ledger.verify("req-cache", "hash-cache")).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("legacy state is the migration base for the first ledger transaction", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cu-ledger-legacy-"));
    try {
      commitExecState(dir, 0, { n: 1 }, "legacy-request");
      const ledger = createSessionLedger(dir);
      const committed = ledger.commitState("req-after-legacy", "hash-after-legacy", 1, { n: 2 }, result());
      expect(committed.version).toBe(2);
      expect(loadExecState(dir)).toEqual({ version: 2, value: { n: 2 } });
      expect(ledger.readStateVersion(1).value).toEqual({ n: 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an uncommitted candidate has no result or state and cannot be replayed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cu-ledger-pending-"));
    try {
      const ledger = createSessionLedger(dir);
      expect(ledger.read("never-committed")).toBeUndefined();
      expect(loadExecState(dir)).toEqual({ version: 0, value: {} });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a torn or corrupted transaction record fails closed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cu-ledger-corrupt-"));
    try {
      const ledger = createSessionLedger(dir);
      ledger.commitState("req-corrupt", "hash-corrupt", 0, { n: 1 }, result());
      await writeFile(join(dir, "transactions", "req-corrupt.json"), "{truncated");
      expect(() => ledger.read("req-corrupt")).toThrow(/corrupt session transaction/);
      expect(() => loadExecState(dir)).toThrow(/corrupt session transaction/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("state through the host (C2)", () => {
  test("the plan's reference case: failed commits do not advance state", async () => {
    const host = await startTestHost({ driver: "fake", idleTimeoutMs: 60_000 });
    try {
      await host.exec({ code: "state.n = 1;" });
      const failed = await host.exec({ code: "state.n = 2; throw new Error('stop');" });
      const next = await host.exec({ code: "return state.n;" });
      expect(failed.result.stateCommitted).toBe(false);
      expect((next.result as { value: unknown }).value).toBe(1);
    } finally {
      await host.close();
      await host.cleanup();
    }
  }, 60_000);

  test("repeated request ids do not re-run state increments", async () => {
    const host = await startTestHost({ driver: "fake", idleTimeoutMs: 60_000 });
    try {
      const { reply } = await host.exec({ code: "state.counts = (state.counts ?? 0) + 1; return state.counts;" });
      expect(reply.status).toBe("completed");
      // same id + IDENTICAL operation content (timeoutMs/maxActions included)
      const second = await host.send({
        schemaVersion: 1,
        sessionId: host.sessionId,
        generation: host.generation,
        requestId: reply.requestId,
        operation: {
          kind: "exec",
          code: "state.counts = (state.counts ?? 0) + 1; return state.counts;",
          sourceName: "script.js",
          timeoutMs: 60_000,
          maxActions: 100
        }
      });
      // dedup: same id + same content returns the recorded outcome
      expect(second.status).toBe("completed");
      const check = await host.exec({ code: "return state.counts;" });
      expect((check.result as { value: unknown }).value).toBe(1);
    } finally {
      await host.close();
      await host.cleanup();
    }
  }, 60_000);

  test("non-JSON state from a script is refused, not committed", async () => {
    const host = await startTestHost({ driver: "fake", idleTimeoutMs: 60_000 });
    try {
      const bad = await host.exec({ code: "state.when = new Date(); return 1;" });
      expect(bad.result.status).toBe("failed");
      expect(bad.result.stateCommitted).toBe(false);
      expect(bad.result.error?.code).toBe("state_invalid");
    } finally {
      await host.close();
      await host.cleanup();
    }
  }, 60_000);
});
