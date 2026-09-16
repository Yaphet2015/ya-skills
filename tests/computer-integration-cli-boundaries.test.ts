import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  ComputerError,
  createRequestJournal,
  type AxElement,
  type BatchRequest,
  type BatchResult,
  type Computer,
  type ComputerSession,
  type Observation,
  type Target,
  type WindowRef
} from "@ya-skills/computer-runtime";
import { createComputerUseCommands } from "../packages/functions-computer-use/src/commands.js";
import { batchCommand } from "../packages/functions-computer-use/src/batch-command.js";
import type { SessionInfo } from "../packages/computer-session/src/types.js";
import { startIntegrationCliPeer } from "./helpers/integration-cli-peer.js";

function sessionInfo(id: string): SessionInfo {
  return {
    id,
    target: { pid: 4242, windowId: "12345" },
    state: "idle",
    hostPid: process.pid,
    generation: randomUUID(),
    idleTimeoutMs: 120_000
  };
}

describe("public session CLI request envelopes", () => {
  test("session batch uses the real encoder/client and keeps CLI metadata outside operation", async () => {
    const root = await mkdtemp(join(tmpdir(), "cu-integration-cli-batch-"));
    const file = join(root, "steps.json");
    const id = randomUUID();
    const peer = await startIntegrationCliPeer(root);
    try {
      await writeFile(file, JSON.stringify({ actions: [{ kind: "key", key: "Return" }] }));
      const commands = createComputerUseCommands({
        sessionTransport: {
          findSession: async () => ({ socketPath: peer.socketPath, info: sessionInfo(id) })
        }
      });
      const command = commands.find((entry) => entry.action === "batch");
      expect(command).toBeDefined();

      const output = await command!.run([
        "--session", id,
        "--file", file,
        "--request-id", "integration-batch"
      ]);
      expect(JSON.parse(output as string).result.status).toBe("completed");
      expect(peer.requests).toHaveLength(1);
      const request = peer.requests[0]!;
      expect(request.requestId).toBe("integration-batch");
      expect(request.operation).toEqual({
        kind: "batch",
        request: { actions: [{ kind: "key", key: "Return" }] }
      });
      expect(Object.keys(request.operation)).toEqual(["kind", "request"]);
    } finally {
      await peer.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("session act routes through the strict batch operation envelope", async () => {
    const root = await mkdtemp(join(tmpdir(), "cu-integration-cli-act-"));
    const id = randomUUID();
    const peer = await startIntegrationCliPeer(root);
    try {
      const commands = createComputerUseCommands({
        sessionTransport: {
          findSession: async () => ({ socketPath: peer.socketPath, info: sessionInfo(id) })
        }
      });
      const command = commands.find((entry) => entry.action === "act");
      expect(command).toBeDefined();

      const output = await command!.run(["--session", id, "--type", "hello"]);
      expect(JSON.parse(output as string).result.status).toBe("completed");
      expect(peer.requests).toHaveLength(1);
      const request = peer.requests[0]!;
      expect(request.operation).toEqual({
        kind: "batch",
        request: { actions: [{ kind: "type", text: "hello" }] }
      });
      expect(Object.keys(request.operation)).toEqual(["kind", "request"]);
      expect(request.requestId).toMatch(/^act-/);
    } finally {
      await peer.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function observation(target: Target): Observation {
  return {
    id: randomUUID(),
    target,
    capturedAt: Date.now(),
    epoch: "integration-epoch",
    revision: 1,
    title: "fixture",
    ax: { status: "usable", elements: [], total: 0, returned: 0, complete: true },
    image: { status: "unavailable" }
  };
}

function fakeBatchSession(
  observe: Computer["observe"]
): ComputerSession {
  const target: Target = { pid: 1, windowId: 10n };
  const windows: WindowRef[] = [{ pid: target.pid, windowId: target.windowId, title: "fixture" }];
  const computer: Computer = {
    apps: async () => [],
    windows: async () => windows,
    snapshot: async () => ({ elements: [] as AxElement[], title: "fixture" }),
    observe,
    clickPoint: async () => undefined,
    batch: async (_target: Target, request: BatchRequest): Promise<BatchResult> => ({
      status: "completed",
      steps: request.actions.map((action, index) => ({ index, kind: action.kind, status: "delivered" }))
    }),
    click: async () => undefined,
    setValue: async () => ({ route: "accessibility", effect: "confirmed" }),
    type: async () => undefined,
    key: async () => undefined,
    scroll: async () => undefined,
    waitFor: async () => []
  };
  return {
    computer,
    metadata: async () => ({ driverVersion: "integration-fixture", pid: 1 }),
    permissions: async () => ({ accessibility: true, screenRecording: true }),
    close: async () => undefined
  };
}

async function readTerminal(requestsDir: string, requestId: string) {
  const record = await createRequestJournal(requestsDir).read(requestId);
  const terminal = record.events[record.events.length - 1];
  expect(terminal?.type).toBe("request_finished");
  return { record, terminal: terminal! };
}

describe("standalone batch final observation terminal truth", () => {
  async function makeCase(
    observe: Computer["observe"],
    timeoutMs = 30
  ): Promise<{ root: string; file: string; requestsDir: string; run: ReturnType<typeof batchCommand> }> {
    const root = await mkdtemp(join(tmpdir(), "cu-integration-cli-final-"));
    const file = join(root, "steps.json");
    const requestsDir = join(root, "requests");
    await writeFile(file, JSON.stringify({
      actions: [{ kind: "key", key: "Return" }],
      observe: { mode: "ax" },
      timeoutMs
    }));
    const run = batchCommand({
      requestsDir,
      createSession: () => fakeBatchSession(observe)
    });
    return { root, file, requestsDir, run };
  }

  test("command_timeout during final observation is interrupted, not completed", async () => {
    const requestId = "final-timeout";
    const testCase = await makeCase(
      async () => {
        throw new ComputerError("command_timeout", "native observation budget expired", "unknown");
      }
    );
    try {
      const failure = await testCase.run({ pid: 1, file: testCase.file, requestId }).then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      const payload = JSON.parse((failure as Error).message);
      expect(payload.error.code).toBe("batch_interrupted");
      expect(payload.error.result.status).toBe("interrupted");
      expect(payload.error.result.steps).toEqual([{ index: 0, kind: "key", status: "delivered" }]);
      const { record, terminal } = await readTerminal(testCase.requestsDir, requestId);
      expect(record.status).toBe("interrupted");
      expect(terminal.payload.status).toBe("interrupted");
      expect((terminal.payload.result as { status: string }).status).toBe("interrupted");
    } finally {
      await rm(testCase.root, { recursive: true, force: true });
    }
  });

  test("cancellation during final observation is interrupted with delivered receipts", async () => {
    const requestId = "final-cancelled";
    const testCase = await makeCase(
      async () => {
        throw new ComputerError("aborted", "the observation was cancelled", "not_delivered");
      }
    );
    try {
      const failure = await testCase.run({ pid: 1, file: testCase.file, requestId }).then(() => null, (error: unknown) => error);
      const payload = JSON.parse((failure as Error).message);
      expect(payload.error.code).toBe("batch_interrupted");
      expect(payload.error.result.status).toBe("interrupted");
      expect(payload.error.result.steps[0]).toMatchObject({ index: 0, status: "delivered" });
      const { record, terminal } = await readTerminal(testCase.requestsDir, requestId);
      expect(record.status).toBe("interrupted");
      expect(terminal.payload.status).toBe("interrupted");
      expect((terminal.payload.result as { status: string }).status).toBe("interrupted");
    } finally {
      await rm(testCase.root, { recursive: true, force: true });
    }
  });

  test("a successful final observation that crosses the deadline is still interrupted", async () => {
    const requestId = "final-after-deadline";
    const testCase = await makeCase(
      async (target) => {
        await new Promise((resolve) => setTimeout(resolve, 140));
        return observation(target);
      },
      100
    );
    try {
      const failure = await testCase.run({ pid: 1, file: testCase.file, requestId }).then(() => null, (error: unknown) => error);
      const payload = JSON.parse((failure as Error).message);
      expect(payload.error.code).toBe("batch_interrupted");
      expect(payload.error.result.status).toBe("interrupted");
      expect(payload.error.result.observationError.code).toBe("batch_deadline");
      expect(payload.error.result.steps[0]).toMatchObject({ index: 0, status: "delivered" });
      const { record, terminal } = await readTerminal(testCase.requestsDir, requestId);
      expect(record.status).toBe("interrupted");
      expect(terminal.payload.status).toBe("interrupted");
      expect((terminal.payload.result as { status: string }).status).toBe("interrupted");
    } finally {
      await rm(testCase.root, { recursive: true, force: true });
    }
  });
});
