import { describe, expect, test } from "bun:test";
import { startTestHost } from "./helpers/session-worker.js";

// Real subprocesses, real SIGTERM/SIGKILL — no fake clocks.

describe("exec lifecycle (C3)", () => {
  test("the plan's reference case: an infinite loop is reclaimed by the watchdog", async () => {
    const host = await startTestHost({ driver: "fake", idleTimeoutMs: 60_000 });
    try {
      const result = await host.exec({
        code: "while (true) {}",
        timeoutMs: 100
      });
      expect(result.reply.status).toBe("interrupted");
      expect(result.result.error?.code).toBe("execution_timeout");
      expect(result.result.stateCommitted).toBe(false);
      const diagnostics = await host.diagnostics();
      expect(diagnostics.liveExecWorkers ?? 0).toBe(0);
      // the session itself is still usable for status
      expect((await host.control("status")).info?.state).toMatch(/idle|running/);
    } finally {
      await host.close();
      await host.cleanup();
    }
  }, 60_000);

  test("timeout waits for a delayed native dispatch before admitting another exec", async () => {
    const host = await startTestHost({
      driver: "fake",
      idleTimeoutMs: 60_000,
      batchResult: async (request) => {
        // 1500 ms fixture latency vs the 1000 ms exec budget below: the
        // dispatch must reliably be in flight when the timeout fires, even
        // when a loaded CI runner needs a few hundred ms to spawn the script
        // worker (the old 250/100 pair broke that premise on GitHub runners).
        await new Promise((resolve) => setTimeout(resolve, 1500));
        return { status: "completed", steps: request.actions.map((action, index) => ({ index, kind: action.kind, status: "delivered" })) };
      }
    });
    try {
      const started = Date.now();
      const timedOut = await host.exec({ code: "await computer.key('Return'); return 1;", timeoutMs: 1000 });
      expect(Date.now() - started).toBeGreaterThanOrEqual(200);
      expect(timedOut.result.status).toBe("interrupted");
      const next = await host.exec({ code: "return 2;", timeoutMs: 1_000 });
      expect(next.result.status).toBe("completed");
    } finally {
      await host.close();
      await host.cleanup();
    }
  }, 60_000);

  test("an infinite async wait is also reclaimed", async () => {
    const host = await startTestHost({ driver: "fake", idleTimeoutMs: 60_000 });
    try {
      const result = await host.exec({
        code: "await new Promise(() => undefined);",
        timeoutMs: 100
      });
      expect(result.result.error?.code).toBe("execution_timeout");
      expect(result.result.stateCommitted).toBe(false);
    } finally {
      await host.close();
      await host.cleanup();
    }
  }, 60_000);

  test("script-spawned children die with the worker's process group", async () => {
    const host = await startTestHost({ driver: "fake", idleTimeoutMs: 60_000 });
    try {
      const result = await host.exec({
        code: `
          const { spawn } = await import("node:child_process");
          const child = spawn("/bin/sleep", ["30"], { detached: false });
          void child;
          while (true) {}
        `,
        timeoutMs: 150
      });
      expect(result.result.error?.code).toBe("execution_timeout");
      // the group kill covers ordinary descendants; give the OS a beat
      await new Promise((resolve) => setTimeout(resolve, 300));
      const { execSync } = await import("node:child_process");
      const leftover = execSync("pgrep -f '/bin/sleep 30' || true").toString().trim();
      expect(leftover).toBe("");
    } finally {
      await host.close();
      await host.cleanup();
    }
  }, 60_000);

  test("a successfully returned script still reaps a surviving child", async () => {
    const host = await startTestHost({ driver: "fake", idleTimeoutMs: 60_000 });
    try {
      const result = await host.exec({
        code: `
          const { spawn } = await import("node:child_process");
          const child = spawn("/bin/sleep", ["30"], { detached: false });
          void child;
          return 1;
        `
      });
      expect(result.result.status).toBe("completed");
      await new Promise((resolve) => setTimeout(resolve, 300));
      const { execSync } = await import("node:child_process");
      const leftover = execSync("pgrep -f '/bin/sleep 30' || true").toString().trim();
      expect(leftover).toBe("");
    } finally {
      await host.close();
      await host.cleanup();
    }
  }, 60_000);

  test("returning with an unawaited facade call refuses completion", async () => {
    const host = await startTestHost({ driver: "fake", idleTimeoutMs: 60_000 });
    try {
      const result = await host.exec({
        code: `
          void computer.type("not awaited");
          return "must not be treated as completed";
        `
      });
      expect(result.result.status).toBe("failed");
      expect(result.result.error?.code).toBe("unawaited_actions");
      expect(result.result.stateCommitted).toBe(false);
    } finally {
      await host.close();
      await host.cleanup();
    }
  }, 60_000);

  test("a failed single facade action rejects and prevents later actions", async () => {
    const host = await startTestHost({
      driver: "fake",
      batchResult: (request) => ({
        status: "failed",
        steps: request.actions.map((action, index) => ({
          index,
          kind: action.kind,
          status: "not_delivered",
          error: { code: "fixture_refusal", message: "refused" }
        }))
      })
    });
    try {
      const result = await host.exec({
        code: "await computer.key('Return'); await computer.type('must-not-run'); return 1;"
      });
      expect(result.result.status).toBe("failed");
      expect(result.result.error?.code).toBe("fixture_refusal");
      expect(result.result.actions?.map((a) => a.kind)).toEqual(["key"]);
    } finally {
      await host.close();
      await host.cleanup();
    }
  }, 60_000);

  test("late RPCs after the request finished are refused, never delivered", async () => {
    const host = await startTestHost({ driver: "fake", idleTimeoutMs: 60_000 });
    try {
      const first = await host.exec({
        code: "await computer.type('a'); return 1;"
      });
      expect(first.result.status).toBe("completed");
      expect((first.result.actions ?? []).map((a) => a.status)).toEqual(["delivered"]);
      // A second exec is a NEW request; the old worker is gone, so its (dead)
      // connection cannot smuggle extra actions into the session.
      const second = await host.exec({ code: "return 2;" });
      expect(second.result.status).toBe("completed");
      const check = await host.diagnostics();
      expect(check.deliveries).toBeGreaterThanOrEqual(1);
    } finally {
      await host.close();
      await host.cleanup();
    }
  }, 60_000);

  test("log overflow closes admission before a later input can be delivered", async () => {
    const host = await startTestHost({ driver: "fake", idleTimeoutMs: 60_000 });
    try {
      const result = await host.exec({
        code: "console.log('x'.repeat(70 * 1024)); await computer.key('Return'); return 1;"
      });
      expect(result.result.status).toMatch(/failed|interrupted/);
      expect(result.result.error?.code).toBe("output_limit");
      expect((await host.diagnostics()).deliveries).toBe(0);
    } finally {
      await host.close();
      await host.cleanup();
    }
  }, 60_000);

  test("exceeding the action budget fails loud with receipts so far", async () => {
    const host = await startTestHost({ driver: "fake", idleTimeoutMs: 60_000 });
    try {
      const result = await host.exec({
        code: `
          for (let i = 0; i < 10; i++) {
            await computer.key("Tab");
          }
          return "never";
        `,
        maxActions: 3
      });
      expect(result.result.status).toBe("failed");
      expect(result.result.error?.code).toBe("action_budget_exceeded");
      const statuses = result.result.actions?.map((a) => a.status) ?? [];
      expect(statuses.filter((s) => s === "delivered").length).toBeLessThanOrEqual(3);
    } finally {
      await host.close();
      await host.cleanup();
    }
  }, 60_000);

  test("no stray exec worker processes survive the test run", async () => {
    const { execSync } = await import("node:child_process");
    const host = await startTestHost({ driver: "fake", idleTimeoutMs: 60_000 });
    await host.exec({ code: "return 1;" }).catch(() => undefined);
    await host.close();
    await host.cleanup();
    // Bun runs test files concurrently, so another file may still be
    // finishing its private worker when this assertion first runs. Poll for
    // quiescence rather than turning that harmless overlap into a false leak;
    // a real orphan still fails after the bounded grace period.
    const deadline = Date.now() + 5_000;
    let stray = "";
    while (Date.now() < deadline) {
      stray = execSync("pgrep -fl '__computer-exec-worker' || true").toString().trim();
      if (stray === "") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(stray).toBe("");
  }, 60_000);
});
