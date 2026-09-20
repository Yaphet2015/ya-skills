import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRequest } from "../packages/functions-computer-use/src/args.js";
import { parseSessionArgs, sessionCommand } from "../packages/functions-computer-use/src/session-command.js";
import { createComputerUseCommands } from "../packages/functions-computer-use/src/commands.js";
import { openSession, sendControl, sendRequest } from "../packages/computer-session/src/index.js";
import { randomUUID } from "node:crypto";

describe("parseRequest/session parsing (B4)", () => {
  test("the plan's reference failures", () => {
    expect(() => parseRequest("observe", ["--session", "s", "--pid", "1"])).toThrow(/exclusive/);
    expect(() => parseRequest("session", ["cancel", "--session", "s"])).toThrow(/request-id/);
  });

  test("session subcommands parse strictly", () => {
    expect(() => parseSessionArgs(["reboot"])).toThrow(/open\|status\|cancel\|close/);
    expect(() => parseSessionArgs(["status"])).toThrow(/--session/);
    expect(() => parseSessionArgs(["open", "--pid", "x"])).toThrow(/--pid/);
    expect(() => parseSessionArgs(["open", "--pid", "1", "--idle-timeout-ms", "999999"])).toThrow(/120000/);
    expect(() => parseSessionArgs(["close", "--session", "s", "--bogus", "1"])).toThrow(/unknown flag/);
    const parsed = parseSessionArgs(["open", "--pid", "123", "--window", "456", "--idle-timeout-ms", "60000"]);
    expect(parsed).toEqual({ sub: "open", pid: 123, windowId: 456n, idleTimeoutMs: 60_000 });
  });

  test("session-owned artifact paths cannot silently ignore --out-dir", () => {
    expect(() => parseRequest("observe", ["--session", "s", "--out-dir", "/tmp/out"])).toThrow(/one-shot|session-owned/);
    expect(() => parseRequest("batch", ["--session", "s", "--out-dir", "/tmp/out", "--file", "f", "--request-id", "r"])).toThrow(/one-shot|session-owned/);
  });

  test("observe/batch/act accept --session without --pid", () => {
    expect(parseRequest("observe", ["--session", "s", "--mode", "ax"])).toMatchObject({
      kind: "observe",
      session: "s"
    });
    expect(parseRequest("batch", ["--session", "s", "--file", "f.json", "--request-id", "r"])).toMatchObject({
      kind: "batch",
      session: "s"
    });
    expect(() => parseRequest("batch", ["--session", "s", "--request-id", "r"])).toThrow(/--file/);
  });

  test("session ids must be UUIDs for status/cancel/close", () => {
    expect(() => parseSessionArgs(["status", "--session", "nope"])).toThrow(/UUID/);
  });

  test("session act forwards key modifiers and requests a reusable observation", async () => {
    const sessionId = randomUUID();
    const observation = {
      id: randomUUID(), target: { pid: 42, windowId: 7n },
      capturedAt: Date.now(), epoch: "fixture", revision: 1, title: "Fixture",
      ax: { status: "usable", elements: [], total: 0, returned: 0, complete: true },
      image: { status: "unavailable" }
    };
    let operation: unknown;
    const commands = createComputerUseCommands({
      sessionTransport: {
        findSession: async () => ({
          socketPath: "/tmp/ya-skills-test-session.sock",
          info: {
            id: sessionId,
            target: { pid: 42, windowId: "7" },
            state: "idle",
            hostPid: process.pid,
            generation: randomUUID(),
            idleTimeoutMs: 120_000
          }
        }),
        sendRequest: async (_socketPath, request) => {
          operation = request.operation;
          return {
            schemaVersion: 1,
            requestId: request.requestId,
            status: "completed",
            result: {
              status: "completed",
              steps: [{ index: 0, kind: "key", status: "delivered" }],
              observation
            }
          };
        }
      }
    });
    const output = await commands.find((command) => command.action === "act")!.run([
      "--session", sessionId, "--key", "I", "--modifiers", "cmd,alt", "--format", "observation"
    ]);
    expect(operation).toEqual({
      kind: "batch",
      request: {
        actions: [{ kind: "key", key: "I", modifiers: ["cmd", "option"] }],
        observe: { mode: "auto" }
      }
    });
    expect(JSON.parse(output as string)).toMatchObject({
      schemaVersion: 1, target: { pid: 42, windowId: "7" },
      observation: { id: observation.id, ax: { status: "usable" } }
    });
  });

  test("session act preserves a failed step refusal when a valid observation is also present", async () => {
    const sessionId = randomUUID();
    const refusalMessage = "key was refused: target is not editable";
    const commands = createComputerUseCommands({
      sessionTransport: {
        findSession: async () => ({
          socketPath: "/tmp/ya-skills-test-session.sock",
          info: {
            id: sessionId,
            target: { pid: 42, windowId: "7" },
            state: "idle",
            hostPid: process.pid,
            generation: randomUUID(),
            idleTimeoutMs: 120_000
          }
        }),
        sendRequest: async (_socketPath, request) => ({
          schemaVersion: 1,
          requestId: request.requestId,
          status: "completed",
          result: {
            status: "failed",
            steps: [{
              index: 0,
              kind: "key",
              status: "not_delivered",
              error: { code: "action_refused", message: refusalMessage }
            }],
            observation: {
              id: randomUUID(),
              target: { pid: 42, windowId: 7n },
              capturedAt: Date.now(),
              epoch: "fixture-epoch",
              revision: 1,
              title: "Fixture",
              ax: { status: "usable", elements: [], total: 0, returned: 0, complete: true },
              image: { status: "unavailable" }
            }
          }
        })
      }
    });
    const error = await Promise.resolve(commands.find((command) => command.action === "act")!.run([
      "--session", sessionId, "--key", "Return", "--format", "observation"
    ])).then(() => null, (e: Error) => e);
    const body = JSON.parse(error!.message).error;
    expect(body.code).toBe("action_refused");
    expect(body.message).toBe(refusalMessage);
    expect(body.actionOutcome).toBe("not_delivered");
    expect(body.nextStep).toMatch(/observe|correct|retry/i);
  });
});

describe("session command orchestration (desktop-free)", () => {
  test("session batch preserves file errors before contacting the host", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yk-session-batch-errors-"));
    let lookups = 0;
    const command = createComputerUseCommands({
      sessionTransport: {
        findSession: async () => {
          lookups++;
          throw new Error("invalid files must not reach the host");
        }
      }
    }).find((entry) => entry.action === "batch")!;
    const run = (file: string) => command.run([
      "--session", "test-session", "--request-id", "file-error", "--file", file
    ]);
    try {
      const invalid = join(dir, "invalid.json");
      await writeFile(invalid, "{");
      await expect(run(invalid)).rejects.toBeInstanceOf(SyntaxError);
      await expect(run(join(dir, "missing.json"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(lookups).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("session open resolves an omitted window through a read-only selector", async () => {
    let openedTarget: { pid: number; windowId: bigint } | undefined;
    const run = sessionCommand({
      resolveWindow: async (pid) => ({ pid, windowId: 987654321012345678n }),
      open: async (options) => {
        openedTarget = options.target;
        return {
          info: {
            id: randomUUID(),
            target: { pid: options.target.pid, windowId: options.target.windowId.toString() },
            state: "idle",
            hostPid: process.pid,
            generation: randomUUID(),
            idleTimeoutMs: options.idleTimeoutMs
          },
          socketPath: "/tmp/not-used.sock",
          configPath: "/tmp/not-used.json",
          hostPid: process.pid
        };
      }
    });
    await run({ sub: "open", pid: 4242, idleTimeoutMs: 1_000 });
    expect(openedTarget).toEqual({ pid: 4242, windowId: 987654321012345678n });
  });

  test("unknown sessions fail with unknown_session, no host spawn", async () => {
    const run = sessionCommand({
      open: async () => {
        throw new Error("open must not be called");
      }
    });
    const id = randomUUID();
    const error = await run({ sub: "status", sessionId: id }).then(() => null, (e: unknown) => e);
    expect((error as Error).message).toMatch(/unknown_session/);
    const closeError = await run({ sub: "close", sessionId: id }).then(() => null, (e: unknown) => e);
    expect((closeError as Error).message).toMatch(/unknown_session/);
  });
});

describe("self-spawned session host closed loop (real subprocess, fake driver)", () => {
  test("open -> observe -> batch -> status -> close reuses one driver", async () => {
    const root = await mkdtemp(join(tmpdir(), "cu-cli-session-"));
    const driverModule = join(root, "fake-driver.ts");
    await writeFile(
      driverModule,
      [
        // Absolute source imports: the host worker runs with a private cwd,
        // so bare workspace names do not resolve from the temp module.
        'import { projectObservation } from ' + JSON.stringify(join(import.meta.dir, "..", "packages", "computer-runtime", "src", "observe.ts")) + ";",
        'import { makeNativeObservation } from ' + JSON.stringify(join(import.meta.dir, "helpers", "computer-fixtures.ts")) + ";",
        "export default async function createFakeDriver() {",
        "  return {",
        "    async call(method, args) {",
        "      if (method === 'observe') {",
        "        const raw = makeNativeObservation();",
        "        return projectObservation(raw, { mode: 'ax' }, { accessibility: true, screenshot: false });",
        "      }",
        "      if (method === 'batch') {",
        "        return { status: 'completed', steps: (args.request?.actions ?? []).map((a, i) => ({ index: i, kind: a.kind, status: 'delivered' })) };",
        "      }",
        "      return null;",
        "    },",
        "    async close() {},",
        "  };",
        "}"
      ].join("\n")
    );
    let opened: Awaited<ReturnType<typeof openSession>>;
    try {
      opened = await openSession({
        target: { pid: 4242, windowId: 12345n },
        root,
        idleTimeoutMs: 120_000,
        driverModule: { path: driverModule }
      });
      expect(opened.info.state).toBe("idle");
      expect(opened.info.hostPid).not.toBe(process.pid);
      expect(opened.info.generation).toBeTruthy();

      const observe = await sendRequest(
        opened.socketPath,
        {
          schemaVersion: 1,
          sessionId: opened.info.id,
          generation: opened.info.generation,
          requestId: "obs-1",
          operation: { kind: "observe", options: { mode: "ax" } }
        },
        15_000
      );
      expect(observe.status).toBe("completed");
      expect((observe.result as { ax: { status: string } }).ax.status).toBe("usable");

      const batch = await sendRequest(
        opened.socketPath,
        {
          schemaVersion: 1,
          sessionId: opened.info.id,
          generation: opened.info.generation,
          requestId: "batch-1",
          operation: {
            kind: "batch",
            request: { actions: [{ kind: "key", key: "Return" }] }
          }
        },
        15_000
      );
      expect(batch.status).toBe("completed");
      expect((batch.result as { steps: Array<{ status: string }> }).steps[0]!.status).toBe("delivered");

      const status = await sendControl(opened.socketPath, { kind: "status", schemaVersion: 1, sessionId: opened.info.id }, 5_000);
      expect(status.info?.state).toBe("idle");

      const close = await sendControl(opened!.socketPath, { kind: "close", schemaVersion: 1, sessionId: opened.info.id }, 15_000);
      expect(close.info?.state ?? "").toMatch(/stopping|closed/);
      // the host process actually exits
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("host did not exit after close")), 10_000);
        void (async () => {
          const hostPid = opened!.info.hostPid;
          for (;;) {
            try {
              process.kill(hostPid, 0);
              await new Promise((r) => setTimeout(r, 200));
            } catch {
              clearTimeout(timer);
              resolve();
              return;
            }
          }
        })();
      });
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 60_000);
});
