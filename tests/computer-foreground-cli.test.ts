import { expect, test } from "bun:test";
import { createComputerUseCommands } from "@ya-skills/functions-computer-use";
import { ComputerError, type Computer, type ComputerSession, type ForegroundController } from "@ya-skills/computer-runtime";

function setup(overrides: Partial<Computer> = {}) {
  const events: string[] = [];
  let currentPid = 20;
  const foregroundController: ForegroundController = {
    readPid: async () => { events.push(`read:${currentPid}`); return currentPid; },
    activate: async (pid) => { events.push(`activate:${pid}`); currentPid = pid; }
  };
  const computer = {
    windows: async () => [{ pid: 10, windowId: 1n, title: "Fixture" }],
    key: async () => { events.push("key"); },
    snapshot: async () => ({ title: "Fixture", elements: [] }),
    ...overrides
  } as unknown as Computer;
  const session: ComputerSession = {
    computer,
    metadata: async () => ({ driverVersion: "fixture", pid: 10 }),
    permissions: async () => ({ accessibility: true, screenRecording: true }),
    close: async () => { events.push("close"); }
  };
  const commands = createComputerUseCommands({ createSession: () => session, foregroundController });
  return { events, command: (action: string) => commands.find((c) => c.action === action)! };
}

test("plain background act performs no foreground probes", async () => {
  const f = setup();
  const output = await f.command("act").run(["--pid", "10", "--key", "Return"]);
  expect(JSON.parse(output as string).foreground).toBeUndefined();
  expect(f.events).toEqual(["key", "close"]);
});

test("audited background act reports frontmost pids without activation", async () => {
  const f = setup();
  const output = await f.command("act").run(["--pid", "10", "--key", "Return", "--audit-foreground"]);
  expect(JSON.parse(output as string).foreground).toMatchObject({ requested: false, beforePid: 20, afterPid: 20 });
  expect(f.events).toEqual(["read:20", "key", "read:20", "close"]);
});

test("explicit activation restores prior app and returns a receipt", async () => {
  const f = setup();
  const output = await f.command("act").run(["--pid", "10", "--key", "Return", "--activate"]);
  expect(JSON.parse(output as string).foreground).toMatchObject({ requested: true, beforePid: 20, afterPid: 10, finalPid: 20, restoration: "restored" });
  expect(f.events).toEqual(["read:20", "activate:10", "read:10", "key", "close", "read:10", "activate:20", "read:20"]);
});

test("target ambiguity is resolved before any activation", async () => {
  const f = setup({ windows: async () => [{ pid: 10, windowId: 1n, title: "A" }, { pid: 10, windowId: 2n, title: "B" }] });
  await expect(f.command("act").run(["--pid", "10", "--key", "Return", "--activate"])).rejects.toThrow();
  expect(f.events).toEqual(["close"]);
});

test("refusal retains its outcome and foreground receipt after restoration", async () => {
  const f = setup({ key: async () => { throw new ComputerError("action_refused", "not delivered", "not_delivered"); } });
  const error = await Promise.resolve(f.command("act").run(["--pid", "10", "--key", "Return", "--activate"])).then(() => null, (error: Error) => error);
  const body = JSON.parse(error!.message).error;
  expect(body).toMatchObject({ code: "action_refused", actionOutcome: "not_delivered", foreground: { restoration: "restored" } });
  expect(f.events).toContain("activate:20");
});

test("post-action observation failure preserves delivered status with foreground receipt", async () => {
  const f = setup({ snapshot: async () => { throw new Error("snapshot failed"); } });
  const error = await Promise.resolve(f.command("act").run(["--pid", "10", "--key", "Return", "--activate"])).then(() => null, (error: Error) => error);
  const body = JSON.parse(error!.message).error;
  expect(body).toMatchObject({ code: "post_action_observe_failed", actionDelivered: true, foreground: { restoration: "restored" } });
  expect(f.events.filter((e) => e === "key")).toHaveLength(1);
});

test("explicit perceive restores the foreground too", async () => {
  const f = setup();
  const output = await f.command("perceive").run(["--pid", "10", "--activate"]);
  expect(JSON.parse(output as string).foreground).toMatchObject({ finalPid: 20, restoration: "restored" });
  expect(f.events).not.toContain("key");
});
