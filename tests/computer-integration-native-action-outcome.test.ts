import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendControl, sendRequest, startHost, type HostConfig, type SessionRequest } from "@ya-skills/computer-session";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("native action outcome across the production IPC boundary", () => {
  test("structured Tool unknown poisons the session and never dispatches queued actions", async () => {
    const root = await mkdtemp(join(tmpdir(), "cu-native-action-outcome-"));
    const sessionId = randomUUID();
    const generation = randomUUID();
    const target = {
      // The root is unique per test; the random target id also avoids sharing a
      // fake app lease with another test process.
      pid: 100_000 + Math.floor(Math.random() * 100_000),
      windowId: "12345"
    };
    const socketPath = join(
      tmpdir(),
      "cu-native-" + sessionId.replaceAll("-", "").slice(0, 16) + ".sock"
    );
    const config: HostConfig = {
      schemaVersion: 1,
      sessionId,
      generation,
      target,
      root,
      socketPath,
      idleTimeoutMs: 120_000,
      requestsDir: join(root, "requests"),
      driver: {
        kind: "module",
        path: join(import.meta.dir, "helpers/structured-tool-unknown-subprocess-driver.ts"),
        export: "createStructuredToolUnknownSubprocessDriver"
      }
    };
    const requestId = "structured-tool-unknown";
    const request: SessionRequest = {
      schemaVersion: 1,
      sessionId,
      generation,
      requestId,
      operation: {
        kind: "batch",
        request: {
          actions: [
            { kind: "type", text: "delivery is unknown" },
            { kind: "key", key: "Return" }
          ],
          maxActions: 2
        }
      }
    };
    let host: Awaited<ReturnType<typeof startHost>> | undefined;
    try {
      // No inProcessDriver is supplied: the host uses the production
      // subprocess driver handle, with the runtime session in that worker.
      host = await startHost(config);

      const first = await sendRequest(socketPath, request, 30_000);
      expect(first.status).toBe("unknown");
      expect(first.error?.code).toBe("action_failed");
      const firstResult = first.result as {
        status: string;
        steps: Array<{ status: string; error?: { code?: string } }>;
      };
      expect(firstResult.status).toBe("interrupted");
      expect(firstResult.steps.map((step) => step.status)).toEqual(["unknown", "not_run"]);
      expect(firstResult.steps[0]?.error?.code).toBe("action_failed");

      // The journal result is returned for an identical request id. It must not
      // enter the worker a second time, even while unknown has shut down the
      // driver and left the host queryable.
      const duplicate = await sendRequest(socketPath, request, 30_000);
      expect(duplicate).toEqual(first);

      let status = await sendControl(socketPath, { kind: "status", schemaVersion: 1, sessionId }, 10_000);
      const stateDeadline = Date.now() + 10_000;
      while (status.info?.state !== "unusable" && Date.now() < stateDeadline) {
        await sleep(20);
        status = await sendControl(socketPath, { kind: "status", schemaVersion: 1, sessionId }, 10_000);
      }
      expect(status.info?.state).toBe("unusable");

      const afterUnknown = await sendRequest(socketPath, {
        ...request,
        requestId: "after-unknown",
        operation: { kind: "batch", request: { actions: [{ kind: "key", key: "Escape" }] } }
      }, 10_000);
      expect(afterUnknown.status).toBe("failed");
      expect(afterUnknown.error?.code).toBe("session_closed");

      const calls = JSON.parse(await readFile(join(root, "structured-tool-calls.json"), "utf8")) as {
        type: number;
        key: number;
      };
      expect(calls).toEqual({ type: 1, key: 0 });

      const leasePath = join(root, "leases", "app-" + target.pid + ".lease");
      expect(existsSync(leasePath)).toBe(true);

      const eventsPath = join(root, sessionId, "requests", requestId, "events.jsonl");
      const events = (await readFile(eventsPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
      const actionFinished = events
        .filter((event) => event.type === "action_finished")
        .map((event) => ({
          index: event.payload.index,
          outcome: event.payload.outcome
        }));
      expect(actionFinished).toEqual([
        { index: 0, outcome: "unknown" },
        { index: 1, outcome: "not_run" }
      ]);
      const terminal = events.filter((event) => event.type === "request_finished");
      expect(terminal).toHaveLength(1);
      expect(terminal[0]?.payload.status).toBe("unknown");
      expect(existsSync(socketPath)).toBe(true);
    } finally {
      await host?.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
      await rm(socketPath, { force: true }).catch(() => undefined);
    }
  }, 60_000);
});
