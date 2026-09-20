import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExec } from "../packages/computer-session/src/exec-runner.js";

test("cancellation during worker startup is observed before accepting script actions", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "exec-start-cancel-"));
  const caller = new AbortController();
  let calls = 0;
  let commits = 0;
  try {
    const result = await runExec({
      sessionId: randomUUID(), generation: randomUUID(), target: { pid: process.pid, windowId: 1n }, stateDir,
      driverCall: async () => { calls++; throw new Error("cancelled request dispatched input"); },
      finalObserve: async () => { calls++; return null; },
      onExecWorkerSpawn: () => caller.abort(),
      commitState: () => { commits++; throw new Error("cancelled request committed state"); }
    }, "cancel-at-start", {
      code: "while (true) {}", sourceName: "cancel.js", timeoutMs: 5_000, maxActions: 1
    }, caller.signal);
    expect(result.status).toBe("interrupted");
    expect(result.error?.code).toBe("request_cancelled");
    expect(result.stateCommitted).toBe(false);
    expect(calls).toBe(0);
    expect(commits).toBe(0);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}, 20_000);
