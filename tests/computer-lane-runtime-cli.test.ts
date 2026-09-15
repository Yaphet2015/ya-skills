import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import {
  createComputerUseCommands
} from "../packages/functions-computer-use/src/commands.js";
import {
  sessionCommand,
  type SessionTransportDeps
} from "../packages/functions-computer-use/src/session-command.js";
import type { SessionInfo, SessionReply, SessionRequest } from "../packages/computer-session/src/types.js";

function sessionInfo(state: SessionInfo["state"] = "unusable"): SessionInfo {
  return {
    id: randomUUID(),
    target: { pid: 4242, windowId: "12345" },
    state,
    hostPid: process.pid,
    generation: randomUUID(),
    idleTimeoutMs: 120_000
  };
}

function deadControl(): never {
  throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
}

describe("runtime lane session control recovery", () => {
  test("status and close recover a validated unusable session with a dead listener", async () => {
    const id = randomUUID();
    const info = { ...sessionInfo("unusable"), id };
    const transport: SessionTransportDeps = {
      findSession: async () => ({ socketPath: "/tmp/retained-dead-listener.sock", info }),
      sendControl: async () => deadControl(),
      isHostAlive: () => false
    };
    const run = sessionCommand(transport);

    const status = JSON.parse(await run({ sub: "status", sessionId: id }));
    expect(status.session).toEqual(info);
    expect(status.cleanup).toMatchObject({ hostUnavailable: true, leaseRetained: true });

    const close = JSON.parse(await run({ sub: "close", sessionId: id }));
    expect(close.session).toEqual(info);
    expect(close.cleanup).toMatchObject({ hostUnavailable: true, leaseRetained: true });
  });

  test("dead-listener fallback refuses malformed session identity", async () => {
    const requestedId = randomUUID();
    const malformed = sessionInfo("unusable");
    let controlCalls = 0;
    const run = sessionCommand({
      findSession: async () => ({ socketPath: "/tmp/dead.sock", info: malformed }),
      sendControl: async () => {
        controlCalls++;
        return deadControl();
      },
      isHostAlive: () => false
    });
    const error = await run({ sub: "status", sessionId: requestedId }).then(() => null, (value: unknown) => value);
    expect((error as Error).message).toMatch(/session_metadata_invalid/);
    expect(controlCalls).toBe(0);
  });

  test("a live host and dead-looking listener are not guessed closed", async () => {
    const id = randomUUID();
    const info = { ...sessionInfo("idle"), id };
    const run = sessionCommand({
      findSession: async () => ({ socketPath: "/tmp/racing.sock", info }),
      sendControl: async () => deadControl(),
      isHostAlive: () => true
    });
    const error = await run({ sub: "status", sessionId: id }).then(() => null, (value: unknown) => value);
    expect((error as Error).message).toMatch(/session_connection_failed/);
  });

  test("public close is repeatable from recorded closed metadata", async () => {
    const id = randomUUID();
    const info = { ...sessionInfo("closed"), id };
    let controls = 0;
    const run = sessionCommand({
      findSession: async () => ({ socketPath: "/tmp/removed.sock", info }),
      sendControl: async () => {
        controls += 1;
        return { schemaVersion: 1, info };
      }
    });
    const first = JSON.parse(await run({ sub: "close", sessionId: id }));
    const second = JSON.parse(await run({ sub: "close", sessionId: id }));
    expect(first.cleanup.alreadyClosed).toBe(true);
    expect(second.cleanup.alreadyClosed).toBe(true);
    expect(controls).toBe(0);
  });
});

describe("runtime lane session CLI budget overrides", () => {
  test("batch overrides are forwarded through the real command routing to a peer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cu-lane-cli-"));
    const file = join(dir, "steps.json");
    const id = randomUUID();
    const info = { ...sessionInfo("idle"), id };
    const sent: Array<{ request: SessionRequest; timeout: number }> = [];
    try {
      await writeFile(file, JSON.stringify({ actions: [{ kind: "key", key: "Return" }] }));
      const commands = createComputerUseCommands({
        sessionTransport: {
          findSession: async () => ({ socketPath: "/tmp/fake-peer.sock", info }),
          sendRequest: async (_socket, request, timeout) => {
            sent.push({ request, timeout });
            return {
              schemaVersion: 1,
              requestId: request.requestId,
              status: "completed",
              result: { status: "completed", steps: [{ index: 0, kind: "key", status: "delivered" }] }
            } satisfies SessionReply;
          }
        }
      });
      const batch = commands.find((command) => command.action === "batch");
      expect(batch).toBeTruthy();
      const output = await batch!.run([
        "--session", id,
        "--file", file,
        "--request-id", "lane-override",
        "--timeout-ms", "7000",
        "--max-actions", "2"
      ]);
      if (typeof output !== "string") throw new Error("batch command did not return its JSON envelope");
      expect(JSON.parse(output).result.status).toBe("completed");
      expect(sent).toHaveLength(1);
      const operation = sent[0]!.request.operation;
      expect(operation.kind).toBe("batch");
      if (operation.kind !== "batch") throw new Error("expected batch operation");
      expect(operation.request.timeoutMs).toBe(7000);
      expect(operation.request.maxActions).toBe(2);
      expect(sent[0]!.timeout).toBe(37_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("runtime lane Node boundary", () => {
  test("Node invoking the internal worker selector gets unsupported_runtime before spawn", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cu-lane-node-"));
    const probe = join(dir, "probe.mjs");
    const processSource = pathToFileURL(resolve("packages/computer-session/src/process.ts")).href;
    await writeFile(
      probe,
      [
        `import { internalSpawnCommand } from ${JSON.stringify(processSource)};`,
        "try {",
        "  internalSpawnCommand('__computer-session-host', '/tmp/lane-config.json');",
        "  process.exitCode = 2;",
        "} catch (error) {",
        "  if (error?.code !== 'unsupported_runtime') process.exitCode = 3;",
        "  else console.log(error.code);",
        "}"
      ].join("\n")
    );
    try {
      const result = Bun.spawnSync(
        ["node", "--experimental-strip-types", probe],
        {
          cwd: process.cwd(),
          env: { ...process.env, BUN_OPTIONS: "" },
          stdout: "pipe",
          stderr: "pipe"
        }
      );
      expect(result.exitCode).toBe(0);
      expect(new TextDecoder().decode(result.stdout).trim()).toBe("unsupported_runtime");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
