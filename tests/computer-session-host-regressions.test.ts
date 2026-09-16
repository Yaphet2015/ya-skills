import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { sendControl } from "../packages/computer-session/src/client.js";
import type { SessionRequest } from "../packages/computer-session/src/types.js";
import { projectObservation } from "@ya-skills/computer-runtime";
import { makeNativeObservation } from "./helpers/computer-fixtures.js";
import { startTestHost } from "./helpers/session-worker.js";

describe("session host direct observe publication guards", () => {
  test("a late direct observe result is interrupted after cancellation", async () => {
    let observeStartedResolve!: () => void;
    const observeStarted = new Promise<void>((resolve) => {
      observeStartedResolve = resolve;
    });
    let releaseObserve!: () => void;
    const pendingObserve = new Promise<void>((resolve) => {
      releaseObserve = resolve;
    });
    const host = await startTestHost({
      driver: "fake",
      idleTimeoutMs: 60_000,
      observeResult: async () => {
        observeStartedResolve();
        await pendingObserve;
        return projectObservation(
          makeNativeObservation({ target: { pid: 4242, windowId: 12345n } }),
          { mode: "ax" },
          { accessibility: true, screenshot: false }
        );
      }
    });
    const request: SessionRequest = {
      schemaVersion: 1,
      sessionId: host.sessionId,
      generation: host.generation,
      requestId: "late-direct-observe",
      operation: { kind: "observe", options: { mode: "ax" } }
    };
    try {
      const running = host.send(request);
      await observeStarted;
      await sendControl(host.socketPath, {
        kind: "cancel",
        schemaVersion: 1,
        sessionId: host.sessionId,
        requestId: request.requestId
      }, 5_000);
      releaseObserve();
      const reply = await running;
      expect(reply.status).toBe("interrupted");
      expect(reply.error?.code).toBe("request_cancelled");
      const events = await readFile(
        host.root + "/" + host.sessionId + "/requests/" + request.requestId + "/events.jsonl",
        "utf8"
      );
      expect(events).toContain('"status":"interrupted"');
      expect(events).not.toContain('"status":"completed"');
    } finally {
      releaseObserve();
      await host.close().catch(() => undefined);
      await host.cleanup();
    }
  }, 30_000);
});
