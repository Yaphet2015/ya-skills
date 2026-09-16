import { describe, expect, test } from "bun:test";
import {
  runSuite,
  type Suite,
  type WorkerEvent
} from "../packages/functions-computer-e2e/src/suite.js";
import {
  createE2ELaneRuntimeFixture,
  integrationContextFor
} from "./helpers/integration-e2e-runtime.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("computer-e2e integration cancellation", () => {
  test("preserves an already-aborted caller signal without dispatch", async () => {
    const fixture = await createE2ELaneRuntimeFixture();
    const caller = new AbortController();
    caller.abort();
    const events: WorkerEvent[] = [];
    try {
      const result = await runSuite(
        {
          apiVersion: 1,
          id: "integration-pre-aborted-caller",
          name: "integration pre-aborted caller",
          tests: [{
            id: "batch",
            name: "caller cancellation",
            async run(context) {
              const batch = await context.computer.batch(fixture.target, {
                actions: [
                  { kind: "key", key: "must-not-run" },
                  { kind: "key", key: "also-must-not-run" }
                ],
                maxActions: 2
              }, caller.signal);
              expect(batch.status).toBe("interrupted");
              expect(batch.steps.map((step) => step.status)).toEqual(["not_run", "not_run"]);
            }
          }]
        },
        integrationContextFor(fixture),
        (event) => events.push(event)
      );
      expect(result.cases[0]?.status).toBe("passed");
      expect(fixture.keyCalls).toEqual([]);
      expect(events.some((event) => event.type === "case_finished")).toBe(true);
    } finally {
      await fixture.close();
    }
  }, 10_000);

  test("combines caller cancellation during the first action and blocks later dispatch in afterAll", async () => {
    const fixture = await createE2ELaneRuntimeFixture({ keyDelayMs: 100 });
    const caller = new AbortController();
    let activeCallerListeners = 0;
    const addListener = caller.signal.addEventListener.bind(caller.signal);
    const removeListener = caller.signal.removeEventListener.bind(caller.signal);
    caller.signal.addEventListener = ((...args: Parameters<AbortSignal["addEventListener"]>) => {
      activeCallerListeners += 1;
      return addListener(...args);
    }) as AbortSignal["addEventListener"];
    caller.signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
      activeCallerListeners -= 1;
      return removeListener(...args);
    }) as AbortSignal["removeEventListener"];
    try {
      const result = await runSuite(
        {
          apiVersion: 1,
          id: "integration-mid-action-caller",
          name: "integration mid-action caller",
          afterAll: async () => {
            // The first fake native call settles while afterAll is running;
            // cancellation must not allow the remaining batch actions through.
            await sleep(250);
          },
          tests: [{
            id: "batch",
            name: "caller cancellation during first action",
            async run(context) {
              const pending = context.computer.batch(fixture.target, {
                actions: [
                  { kind: "key", key: "first" },
                  { kind: "key", key: "second" },
                  { kind: "key", key: "third" }
                ],
                maxActions: 3
              }, caller.signal);
              setTimeout(() => caller.abort(), 10);
              const batch = await pending;
              expect(batch.status).toBe("interrupted");
              expect(batch.steps.map((step) => step.status)).toEqual([
                "delivered",
                "not_run",
                "not_run"
              ]);
            }
          }]
        },
        integrationContextFor(fixture),
        () => undefined
      );
      expect(result.cases[0]?.status).toBe("passed");
      expect(fixture.keyCalls).toEqual(["first"]);
      expect(fixture.keyCalls).not.toContain("second");
      expect(fixture.keyCalls).not.toContain("third");
      expect(activeCallerListeners).toBe(0);
    } finally {
      await fixture.close();
    }
  }, 10_000);
});
