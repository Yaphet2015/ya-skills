import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { batchCommand } from "../packages/functions-computer-use/src/batch-command.js";
import { createRequestJournal, type RequestJournal } from "../packages/computer-runtime/src/request-journal.js";
import type {
  BatchRequest,
  BatchResult,
  Observation,
  Target,
  WindowRef
} from "../packages/computer-runtime/src/types.js";
import type { ComputerSession } from "../packages/computer-runtime/src/session.js";

const TARGET: Target = { pid: 1, windowId: 10n };

function sessionFor(
  onBatch: (request: BatchRequest) => Promise<BatchResult>,
  onObserve: () => Promise<Observation>
): ComputerSession {
  const computer = {
    apps: async () => [],
    windows: async (): Promise<WindowRef[]> => [{ ...TARGET, title: "lane" }],
    snapshot: async () => ({ elements: [], title: "lane" }),
    observe: async () => onObserve(),
    clickPoint: async () => undefined,
    batch: async (_target: Target, request: BatchRequest) => onBatch(request),
    click: async () => undefined,
    type: async () => undefined,
    key: async () => undefined,
    scroll: async () => undefined,
    waitFor: async () => []
  };
  return {
    computer,
    metadata: async () => ({ driverVersion: "lane", pid: 1 }),
    permissions: async () => ({ accessibility: true, screenRecording: true }),
    close: async () => undefined
  };
}

const observation: Observation = {
  id: "01234567-89ab-cdef-0123-456789abcdef",
  target: TARGET,
  capturedAt: Date.now(),
  epoch: "lane",
  revision: 0,
  title: "lane",
  ax: { status: "usable", elements: [], total: 0, returned: 0, complete: true },
  image: { status: "unavailable" }
};

describe("runtime lane standalone batch deadline", () => {
  test("one absolute budget stops later per-action dispatch and final observation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cu-lane-batch-"));
    const file = join(dir, "steps.json");
    const requestsDir = join(dir, "requests");
    const calls: number[] = [];
    let observations = 0;
    let sessionDeadline = 0;
    try {
      await writeFile(
        file,
        JSON.stringify({
          timeoutMs: 30,
          maxActions: 2,
          actions: [
            { kind: "key", key: "Return" },
            { kind: "type", text: "must-not-run" }
          ],
          observe: { mode: "ax" }
        })
      );
      const journal = createRequestJournal(requestsDir);
      const delayedJournal: RequestJournal = {
        claim: (id, hash) => journal.claim(id, hash),
        read: (id) => journal.read(id),
        list: () => journal.list(),
        append: async (id, event) => {
          // Simulate persistence latency after the pre-dispatch budget was
          // measured. A stale relative timeout would incorrectly dispatch.
          if (event.type === "action_started") {
            await new Promise((resolve) => setTimeout(resolve, 45));
          }
          await journal.append(id, event);
        }
      };
      const run = batchCommand({
        requestsDir,
        journal: delayedJournal,
        createSession: (options) => {
          sessionDeadline = options.deadlineAt;
          return sessionFor(
            async (request) => {
              calls.push(request.timeoutMs ?? 0);
              if (calls.length === 1) await new Promise((resolve) => setTimeout(resolve, 45));
              return {
                status: "completed",
                steps: [{ index: 0, kind: request.actions[0]!.kind, status: "delivered" }]
              };
            },
            async () => {
              observations += 1;
              return observation;
            }
          );
        }
      });
      const error = await run({ pid: TARGET.pid, file, requestId: "lane-deadline" }).then(
        () => null,
        (value: unknown) => value
      );
      expect(error).toBeTruthy();
      const payload = JSON.parse((error as Error).message);
      expect(payload.error.code).toBe("batch_interrupted");
      expect(payload.error.result.steps.map((step: { status: string }) => step.status)).toEqual(["not_run", "not_run"]);
      expect(calls).toHaveLength(0);
      expect(observations).toBe(0);
      expect(sessionDeadline - Date.now()).toBeLessThanOrEqual(30);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
