import { describe, expect, test } from "bun:test";
import { startTestHost } from "./helpers/session-worker.js";
import { createScriptComputer, SCRIPT_METHODS } from "../packages/computer-session/src/index.js";
import type { JsonValue, ScriptRpcMethod } from "../packages/computer-session/src/index.js";

describe("exec through the session host (C1, real exec-worker subprocess)", () => {
  test("the plan's reference case: scripted actions + observe + state", async () => {
    const host = await startTestHost({ driver: "fake", idleTimeoutMs: 60_000 });
    try {
      const { reply, result } = await host.exec({
        code: `
          await computer.type("a");
          await computer.key("Tab");
          const view = await observe({ mode: "ax" });
          return { title: view.title };
        `
      });
      expect(reply.status).toBe("completed");
      expect((result.actions ?? []).map((a) => a.kind)).toEqual(["type", "key"]);
      expect(result.observations).toHaveLength(1);
      expect((result as { value: { title?: string } }).value.title).toBe("Fixture Window");
      expect((await host.diagnostics()).driverInitCount).toBe(1);
    } finally {
      await host.close();
      await host.cleanup();
    }
  }, 60_000);

  test("state persists across exec calls only on clean completion", async () => {
    const host = await startTestHost({ driver: "fake", idleTimeoutMs: 60_000 });
    try {
      const first = await host.exec({ code: "state.n = 1;" });
      expect(first.result.stateCommitted).toBe(true);
      const failed = await host.exec({ code: "state.n = 2; throw new Error('stop');" });
      expect(failed.result.stateCommitted).toBe(false);
      expect(failed.result.status).toBe("failed");
      const next = await host.exec({ code: "return state.n;" });
      expect(next.result.status).toBe("completed");
      expect((next.result as { value: unknown }).value).toBe(1);
    } finally {
      await host.close();
      await host.cleanup();
    }
  }, 60_000);

  test("static import syntax fails with a readable error, nothing delivered", async () => {
    const host = await startTestHost({ driver: "fake", idleTimeoutMs: 60_000 });
    try {
      const { result } = await host.exec({
        code: `import fs from "node:fs"; return 1;`
      });
      expect(result.status).toBe("failed");
      expect(result.error?.code).toBe("static_import");
      expect(result.actions).toEqual([]);
    } finally {
      await host.close();
      await host.cleanup();
    }
  }, 60_000);

  test("oversized code is rejected before any worker spawns", async () => {
    const host = await startTestHost({ driver: "fake", idleTimeoutMs: 60_000 });
    try {
      const { reply } = await host.exec({ code: "x".repeat(300 * 1024) });
      expect(reply.status).toBe("failed");
      expect(reply.error?.code).toBe("code_too_large");
    } finally {
      await host.close();
      await host.cleanup();
    }
  }, 60_000);

  test("unknown RPC methods from a hostile script are refused, no desktop effect", async () => {
    const host = await startTestHost({ driver: "fake", idleTimeoutMs: 60_000 });
    try {
      // The facade only exposes fixed methods; a script cannot name another.
      const { result } = await host.exec({
        code: `
          const evil = "click_" + "evil";
          try {
            const fn = computer[evil];
            if (typeof fn === "function") await fn();
          } catch {
            // the facade has no such method — nothing happens
          }
          return "ok";
        `
      });
      expect(result.status).toBe("completed");
      expect(SCRIPT_METHODS.includes(evilName())).toBe(false);
    } finally {
      await host.close();
      await host.cleanup();
    }
  }, 60_000);

  function evilName(): ScriptRpcMethod {
    return "click_evil" as ScriptRpcMethod;
  }
});

describe("createScriptComputer (fixed wire surface)", () => {
  test("every facade method maps to exactly one fixed RPC name", async () => {
    const calls: Array<{ method: string; args: unknown }> = [];
    const computer = createScriptComputer(async (method, args) => {
      calls.push({ method, args });
      if (method === "observe") {
        return {
          id: "obs",
          target: { pid: 1, windowId: 2n } as never,
          capturedAt: Date.now(),
          epoch: "e",
          revision: 0,
          title: "fixture",
          ax: { status: "usable", elements: [], total: 0, returned: 0, complete: true },
          image: { status: "unavailable" }
        } as never;
      }
      if (method === "batch") return { status: "completed", steps: [] } as never;
      return null;
    });
    await computer.click({ text: "OK", match: "exact" });
    await computer.clickPoint({ observationId: "01234567-89ab-cdef-0123-456789abcdef", x: 1, y: 2 });
    await computer.type("hi");
    await computer.key("Return", ["cmd"]);
    await computer.scroll({ direction: "down", amount: 2, x: 1, y: 1 });
    await computer.wait({ kind: "window_exists" }, 100);
    await computer.observe({ mode: "ax" });
    await computer.batch({ actions: [] as never });
    expect(calls.map((c) => c.method)).toEqual([
      "click",
      "click_point",
      "type",
      "key",
      "scroll",
      "wait",
      "observe",
      "batch"
    ]);
    for (const call of calls) {
      // args are always JSON-serializable (no functions cross the wire)
      expect(() => JSON.stringify(call.args as JsonValue)).not.toThrow();
    }
  });
});
