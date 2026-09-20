import { describe, expect, test } from "bun:test";
import { runWithForeground, type ForegroundController } from "../packages/computer-runtime/src/foreground.js";

function fixture(initialPid: number | null = 20) {
  let current = initialPid;
  const activated: number[] = [];
  const controller: ForegroundController = {
    readPid: async () => current,
    activate: async (pid) => { activated.push(pid); current = pid; }
  };
  return { controller, activated, switchTo: (pid: number | null) => { current = pid; } };
}

describe("foreground ownership around an action", () => {
  test("background actions never activate or restore another app", async () => {
    const f = fixture();
    const result = await runWithForeground(10, false, f.controller, async () => {
      f.switchTo(30);
      return "done";
    });
    expect(result.ok).toBe(true);
    expect(f.activated).toEqual([]);
    expect(result.foreground).toMatchObject({ beforePid: 20, afterPid: 30, finalPid: 30, activation: "not_requested", restoration: "not_needed" });
  });

  test("explicit activation restores the actual previous app after success", async () => {
    const f = fixture();
    const result = await runWithForeground(10, true, f.controller, async () => "done");
    expect(result.ok && result.value).toBe("done");
    expect(f.activated).toEqual([10, 20]);
    expect(result.foreground).toMatchObject({ beforePid: 20, afterPid: 10, finalPid: 20, activation: "activated", restoration: "restored" });
  });

  test("an action failure is retained after restoring the previous app", async () => {
    const f = fixture();
    const original = new Error("delivery unknown");
    const result = await runWithForeground(10, true, f.controller, async () => { throw original; });
    expect(!result.ok && result.error).toBe(original);
    expect(f.activated).toEqual([10, 20]);
    expect(result.foreground.restoration).toBe("restored");
  });

  test("a user switching to another app prevents restoration", async () => {
    const f = fixture();
    const result = await runWithForeground(10, true, f.controller, async () => { f.switchTo(30); });
    expect(f.activated).toEqual([10]);
    expect(result.foreground).toMatchObject({ afterPid: 30, finalPid: 30, restoration: "skipped_user_switch" });
  });

  test("already-frontmost target is left in place", async () => {
    const f = fixture(10);
    const result = await runWithForeground(10, true, f.controller, async () => "done");
    expect(f.activated).toEqual([]);
    expect(result.foreground).toMatchObject({ activation: "already_frontmost", restoration: "not_needed" });
  });

  test("failed activation never sends the action", async () => {
    const f = fixture();
    f.controller.activate = async () => {};
    let calls = 0;
    const result = await runWithForeground(10, true, f.controller, async () => { calls++; });
    expect(calls).toBe(0);
    expect(!result.ok && result.error).toMatchObject({ code: "foreground_activation_failed", actionOutcome: "not_delivered" });
  });

  test("missing foreground evidence refuses explicit activation before input", async () => {
    const f = fixture(null);
    let calls = 0;
    const result = await runWithForeground(10, true, f.controller, async () => { calls++; });
    expect(calls).toBe(0);
    expect(f.activated).toEqual([]);
    expect(!result.ok && result.error).toMatchObject({ code: "foreground_unavailable", actionOutcome: "not_delivered" });
  });

  test("background observation failure does not prevent a background action", async () => {
    const f = fixture();
    f.controller.readPid = async () => { throw new Error("cannot inspect apps"); };
    const result = await runWithForeground(10, false, f.controller, async () => "done");
    expect(result.ok && result.value).toBe("done");
    expect(result.foreground.beforePid).toBeNull();
    expect(result.foreground.issues).toHaveLength(2);
    expect(f.activated).toEqual([]);
  });

  test("restore failure never converts delivered work into a retryable error", async () => {
    const f = fixture();
    const activate = f.controller.activate;
    f.controller.activate = async (pid) => {
      if (pid === 20) throw new Error("previous app exited");
      await activate(pid);
    };
    const result = await runWithForeground(10, true, f.controller, async () => "done");
    expect(result.ok && result.value).toBe("done");
    expect(result.foreground.restoration).toBe("failed");
    expect(result.foreground.issues).toContain("restore: previous app exited");
  });

  test("restoration waits for native cleanup after an uncertain action", async () => {
    const f = fixture();
    const failure = new Error("delivery unknown");
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => { release = resolve; });
    let cleanupStarted!: () => void;
    const started = new Promise<void>((resolve) => { cleanupStarted = resolve; });
    const pending = runWithForeground(10, true, f.controller,
      async () => { throw failure; },
      async () => { cleanupStarted(); await cleanup; }
    );
    await started;
    expect(f.activated).toEqual([10]);
    release();
    const result = await pending;
    expect(!result.ok && result.error).toBe(failure);
    expect(f.activated).toEqual([10, 20]);
  });

  test("unsettled native work prevents restoration without masking the action", async () => {
    const f = fixture();
    const failure = new Error("delivery unknown");
    const result = await runWithForeground(10, true, f.controller,
      async () => { throw failure; },
      async () => { throw new Error("native work remained in flight"); }
    );
    expect(!result.ok && result.error).toBe(failure);
    expect(f.activated).toEqual([10]);
    expect(result.foreground.restoration).toBe("failed");
    expect(result.foreground.issues).toContain("cleanup before restore: native work remained in flight");
  });
});
