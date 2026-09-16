import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { stopProcessGroup } from "../packages/computer-session/src/process.js";
import {
  isRunnableProcess,
  parseExecBodyReadyFrame,
  readProcessGroupId
} from "./helpers/integration-release-process.js";

const posixTest = process.platform === "win32" ? test.skip : test;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(read: () => T | null, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== null) return value;
    if (Date.now() >= deadline) throw new Error(`condition did not become true within ${timeoutMs}ms`);
    await delay(25);
  }
}

function stopOwnedGroup(child: ChildProcess): Promise<Awaited<ReturnType<typeof stopProcessGroup>>> {
  return stopProcessGroup(child, 250);
}

describe("release integration loop proof helpers", () => {
  test("accepts only a body-level readiness frame with the reported child pid", () => {
    expect(parseExecBodyReadyFrame(JSON.stringify({ type: "exec_started" }))).toBeNull();
    expect(
      parseExecBodyReadyFrame(JSON.stringify({ type: "exec_body_ready", childPid: 41, reportedPid: 41, ready: false }))
    ).toBeNull();
    expect(
      parseExecBodyReadyFrame(JSON.stringify({ type: "exec_body_ready", childPid: 41, reportedPid: 42, ready: true }))
    ).toBeNull();
    expect(parseExecBodyReadyFrame("not json")).toBeNull();
    expect(parseExecBodyReadyFrame(JSON.stringify({ type: "exec_body_ready", childPid: 41, reportedPid: 41, ready: true }))).toEqual({
      type: "exec_body_ready",
      childPid: 41,
      reportedPid: 41,
      ready: true
    });
  });

  posixTest("proves an owned TERM-ignoring descendant survives TERM before KILL escalation", async () => {
    const child = spawn(
      "/bin/sh",
      ["-c", "trap '' TERM; while :; do sleep 1; done"],
      { detached: true, stdio: "ignore" }
    );
    if (child.pid === undefined) throw new Error("owned process did not expose a pid");
    let stopped: Awaited<ReturnType<typeof stopProcessGroup>> | null = null;
    try {
      const groupId = await waitFor(() => readProcessGroupId(child.pid!), 5_000);
      expect(groupId).toBe(child.pid);
      expect(isRunnableProcess(child.pid)).toBe(true);

      // This is the exact owned process group, not a name-based/global sweep.
      // The fixture installed `trap '' TERM`, so its survival proves TERM did
      // not falsely satisfy the cleanup assertion before escalation.
      process.kill(-groupId, "SIGTERM");
      await delay(150);
      expect(isRunnableProcess(child.pid)).toBe(true);

      stopped = await stopOwnedGroup(child);
      expect(stopped.exited).toBe(true);
      expect(stopped.signal).toBe("SIGKILL");
      expect(stopped.groupSurvivors).toBeNull();
      expect(isRunnableProcess(child.pid)).toBe(false);
    } finally {
      if (stopped === null) await stopOwnedGroup(child).catch(() => undefined);
    }
  }, 20_000);
});
