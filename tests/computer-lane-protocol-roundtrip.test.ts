import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FrameReader, decodeSessionReply } from "../packages/computer-session/src/protocol.js";
import { sendRequest } from "../packages/computer-session/src/client.js";
import type { SessionRequest } from "../packages/computer-session/src/types.js";

const replacer = (_key: string, value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : value;

function observationWithChineseTarget() {
  return {
    id: randomUUID(),
    target: { pid: 4242, windowId: 9007199254740993n },
    capturedAt: 1_700_000_000_000,
    epoch: "roundtrip-epoch",
    revision: 0,
    title: "中文窗口",
    ax: {
      status: "usable",
      elements: [{ role: "AXStaticText", label: "你好", enabled: true }],
      total: 1,
      returned: 1,
      complete: true
    },
    image: { status: "unavailable" }
  };
}

describe("protocol lane wire round trips", () => {
  test("FrameReader preserves Chinese text when every UTF-8 byte is split", () => {
    const reader = new FrameReader();
    const line = `${JSON.stringify({ text: "你好，世界", windowId: "draft" })}\n`;
    const bytes = Buffer.from(line, "utf8");
    const frames: string[] = [];
    for (let index = 0; index < bytes.length; index++) {
      frames.push(...reader.push(bytes.subarray(index, index + 1)));
    }
    expect(frames).toEqual([line.slice(0, -1)]);
  });

  test("the real client preserves arbitrary exec return ids while restoring observation targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "cu-lane-protocol-roundtrip-"));
    const socketPath = join(root, "session.sock");
    const sessionId = randomUUID();
    const requestId = "roundtrip-exec";
    const observation = observationWithChineseTarget();
    const response = {
      schemaVersion: 1,
      requestId,
      status: "completed",
      result: {
        status: "completed",
        value: {
          draft: { windowId: "draft" },
          numeric: { windowId: 123 },
          text: "执行完成"
        },
        stateVersion: 0,
        stateCommitted: false,
        actions: [],
        observations: [observation],
        logs: ["收到中文结果"]
      }
    };
    const server = createServer((connection) => {
      connection.on("data", () => {
        connection.write(`${JSON.stringify(response, replacer)}\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const request: SessionRequest = {
      schemaVersion: 1,
      sessionId,
      generation: randomUUID(),
      requestId,
      operation: {
        kind: "exec",
        code: "return { ok: true }",
        sourceName: "roundtrip.js",
        timeoutMs: 1_000,
        maxActions: 10
      }
    };
    try {
      const reply = await sendRequest(socketPath, request, 5_000);
      const result = reply.result as {
        value: { draft: { windowId: string }; numeric: { windowId: number }; text: string };
        observations: Array<{ target: { windowId: bigint }; title: string }>;
      };
      expect(result.observations[0]!.target.windowId).toBe(9007199254740993n);
      expect(result.observations[0]!.title).toBe("中文窗口");
      expect(result.value).toEqual({
        draft: { windowId: "draft" },
        numeric: { windowId: 123 },
        text: "执行完成"
      });

      // The operation-aware decoder has the same behavior when used directly;
      // this guards the public client and the low-level codec together.
      const direct = decodeSessionReply(`${JSON.stringify(response, replacer)}\n`, request.operation);
      expect((direct.result as typeof result).value.draft.windowId).toBe("draft");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
});
