import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import {
  decodeReply,
  decodeSessionReply,
  decodeRequest,
  encodeRequest,
  FrameReader,
  MAX_MESSAGE_BYTES,
  ProtocolError,
  sessionPaths,
  sendRequest,
  validateSessionId
} from "../packages/computer-session/src/index.js";
import type { SessionRequest, SessionReply } from "../packages/computer-session/src/types.js";

const request: SessionRequest = {
  schemaVersion: 1,
  sessionId: randomUUID(),
  generation: randomUUID(),
  requestId: randomUUID(),
  operation: { kind: "observe", options: { mode: "ax" } }
};

describe("request codec", () => {
  test("the plan's reference case round-trips", () => {
    expect(decodeRequest(encodeRequest(request))).toEqual(request);
  });

  test("windowId arrives as a decimal string and becomes bigint exactly once", () => {
    const batchRequest: SessionRequest = {
      ...request,
      operation: {
        kind: "batch",
        request: {
          actions: [
            { kind: "click_point", point: { observationId: randomUUID(), x: 1, y: 2 } }
          ]
        }
      }
    };
    const decoded = decodeRequest(encodeRequest(batchRequest));
    expect(decoded).toEqual(batchRequest);
  });

  test("schema version mismatches fail with protocol_version", () => {
    expect(() => decodeRequest(JSON.stringify({ ...request, schemaVersion: 2 }))).toThrow(
      /protocol_version/
    );
    expect(() => decodeRequest(JSON.stringify({ ...request, schemaVersion: "1" }))).toThrow(
      /protocol_version/
    );
  });

  test("non-decimal windowIds are rejected, never coerced", () => {
    const bad = encodeRequest(request).replace(/"kind":"observe"/, `"kind":"observe"`);
    const forged = JSON.stringify({
      ...request,
      operation: { kind: "observe", options: { mode: "ax", target: { windowId: "0x1f" } } }
    });
    expect(() => decodeRequest(forged)).toThrow(ProtocolError);
    expect(bad).toContain("observe");
  });

  test("unknown operations and missing identity are rejected", () => {
    expect(() =>
      decodeRequest(JSON.stringify({ ...request, operation: { kind: "reboot" } }))
    ).toThrow(/observe\|batch\|exec/);
    expect(() => decodeRequest(JSON.stringify({ ...request, requestId: "" }))).toThrow(/requestId/);
    expect(() => decodeRequest("not json")).toThrow(/JSON/);
  });

  test("business reply decoding restores a complete observation and rejects an incomplete one", () => {
    const observation = {
      id: "obs-1",
      target: { pid: 7, windowId: "9007199254740993" },
      capturedAt: 1_700_000_000_000,
      epoch: "epoch-1",
      revision: 0,
      title: "你好",
      ax: {
        status: "usable",
        elements: [{ role: "AXButton", label: "保存", frame: { x: 1, y: 2, w: 50, h: 20 }, enabled: true }],
        total: 1,
        returned: 1,
        complete: true
      },
      image: {
        status: "usable",
        frameValid: true,
        geometry: {
          sourceWidth: 1280,
          sourceHeight: 800,
          sentWidth: 1280,
          sentHeight: 800,
          inputBounds: { x: 0, y: 0, width: 640, height: 400 },
          windowBounds: { x: 80, y: 40, width: 640, height: 400 }
        }
      }
    };
    const wire = JSON.stringify({
      schemaVersion: 1,
      requestId: request.requestId,
      status: "completed",
      result: observation
    });
    const decoded = decodeSessionReply(wire, request.operation);
    expect((decoded.result as { target: { windowId: bigint } }).target.windowId).toBe(9007199254740993n);
    expect((decoded.result as { title: string }).title).toBe("你好");
    const { ax: _ax, ...incomplete } = observation;
    expect(() => decodeSessionReply(JSON.stringify({
      schemaVersion: 1,
      requestId: "r",
      status: "completed",
      result: incomplete
    }), request.operation)).toThrow(/protocol_result/);
  });

  test("replies round-trip and reject bad versions", () => {
    const reply: SessionReply = {
      schemaVersion: 1,
      requestId: request.requestId,
      status: "completed",
      result: { note: "ok", windowId: 123n }
    };
    const encoded = JSON.stringify(reply, (k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(decodeReply(encoded)).toEqual({ ...reply, result: { note: "ok", windowId: "123" } });
    const failed = decodeSessionReply(JSON.stringify({
      schemaVersion: 1,
      requestId: request.requestId,
      status: "failed",
      error: { code: "session_busy", message: "another request is running" }
    }), request.operation);
    expect(failed.error).toEqual({ code: "session_busy", message: "another request is running" });
    expect(() => decodeReply(JSON.stringify({ schemaVersion: 9 }))).toThrow(/protocol_version/);
  });
});

describe("FrameReader", () => {
  test("partial frames buffer until the newline; multiple frames split apart", () => {
    const reader = new FrameReader();
    expect(reader.push('{"a":1}')).toEqual([]);
    expect(reader.push("\n")).toEqual(['{"a":1}']);
    expect(reader.push('{"b":2}\n{"c":3}\n')).toEqual(['{"b":2}', '{"c":3}']);
  });

  test("a frame over the 1MiB cap aborts immediately (not after buffering)", () => {
    const reader = new FrameReader();
    const oversized = `${"x".repeat(MAX_MESSAGE_BYTES + 1)}\n`;
    let thrown: unknown = null;
    try {
      reader.push(oversized);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProtocolError);
    expect((thrown as ProtocolError).code).toBe("protocol_message_too_large");
    // poisoned: further pushes are ignored
    expect(reader.push("anything\n")).toEqual([]);
  });

  test("split UTF-8 bytes are decoded without replacement characters", () => {
    const reader = new FrameReader();
    const bytes = Buffer.from(JSON.stringify({ text: "你好" }) + "\n", "utf8");
    const frames: string[] = [];
    for (let i = 0; i < bytes.length; i++) frames.push(...reader.push(bytes.subarray(i, i + 1)));
    expect(frames).toEqual([JSON.stringify({ text: "你好" })]);
  });

  test("several independently valid frames in one chunk do not share a size budget", () => {
    const reader = new FrameReader();
    const one = `${"x".repeat(Math.floor(MAX_MESSAGE_BYTES / 2))}\n`;
    const two = `${"y".repeat(Math.floor(MAX_MESSAGE_BYTES / 2))}\n`;
    expect(reader.push(Buffer.from(one + two))).toHaveLength(2);
  });

  test("a partial frame past the cap aborts before completion", () => {
    const reader = new FrameReader();
    let thrown: unknown = null;
    try {
      reader.push("y".repeat(MAX_MESSAGE_BYTES + 10));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProtocolError);
    expect((thrown as ProtocolError).code).toBe("protocol_message_too_large");
  });
});

describe("sessionPaths", () => {
  test("the plan's traversal attempt is rejected", () => {
    expect(() => sessionPaths("/tmp/private", "../../escape")).toThrow(/session id/);
    expect(() => sessionPaths("/tmp/private", "not-a-uuid")).toThrow(/UUID/);
    expect(() => validateSessionId("")).toThrow();
  });

  test("paths derive from the id; socket stays short and in the temp root", async () => {
    const root = await mkdtemp(join(tmpdir(), "cu-paths-"));
    try {
      const id = randomUUID();
      const paths = sessionPaths(root, id);
      expect(paths.directory).toBe(join(root, id));
      expect(paths.metadata.endsWith("session.json")).toBe(true);
      expect(paths.events.endsWith("events.jsonl")).toBe(true);
      expect(paths.socket.length).toBeLessThanOrEqual(90);
      expect(paths.socket).toContain("ya-skills-cu-");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("client/server roundtrip over a real socket", () => {
  test("one request, one reply; a slow second write is not sent on timeout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cu-proto-sock-"));
    const socketPath = join(dir, "s.sock");
    const received: string[] = [];
    const server = createServer((conn) => {
      conn.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
          received.push(line);
        }
        conn.write(`${JSON.stringify({ schemaVersion: 1, requestId: "r", status: "completed", result: {
          id: "obs", target: { pid: 1, windowId: "2" }, capturedAt: Date.now(), epoch: "e", revision: 0,
          title: "fixture", ax: { status: "usable", elements: [], total: 0, returned: 0, complete: true },
          image: { status: "unavailable" }
        } })}\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const reply = await sendRequest(socketPath, { ...request, requestId: "r" }, 5_000);
      expect(reply.status).toBe("completed");
      expect(received).toHaveLength(1);

      // Timeout: server never answers; the client must not resend.
      const deadServer = createServer(() => undefined);
      const deadPath = join(dir, "dead.sock");
      await new Promise<void>((resolve) => deadServer.listen(deadPath, resolve));
      const missingPath = join(dir, "missing.sock");
      const missingError = await sendRequest(missingPath, { ...request, requestId: "missing" }, 1_000).then(
        () => null,
        (e: unknown) => e
      );
      expect(missingError).toBeInstanceOf(Error);
      expect((missingError as NodeJS.ErrnoException).code).toBe("ENOENT");
      const started = Date.now();
      const error = await sendRequest(deadPath, { ...request, requestId: "r2" }, 300).then(
        () => null,
        (e: unknown) => e
      );
      expect((error as Error).message).toMatch(/no reply within 300ms/);
      expect(Date.now() - started).toBeLessThan(2_000);
      deadServer.close();
    } finally {
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
