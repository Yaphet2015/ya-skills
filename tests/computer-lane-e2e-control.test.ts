import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  runSuite,
  type CaseContext,
  type Suite,
  type WorkerEvent
} from "../packages/functions-computer-e2e/src/suite.js";
import type { Target } from "@ya-skills/computer-runtime";
import {
  createE2ELaneRuntimeFixture,
  type E2ELaneRuntimeFixture
} from "./helpers/e2e-lane-runtime.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function contextFor(fixture: E2ELaneRuntimeFixture): CaseContext {
  return {
    computer: fixture.session.computer,
    signal: new AbortController().signal,
    params: {},
    artifactsDir: join(fixture.root, "artifacts"),
    step: async <T>(_name: string, work: () => Promise<T>): Promise<T> => work(),
    skip: (reason: string): never => {
      throw new Error(`unexpected skip: ${reason}`);
    },
    setApplication: () => undefined,
    capture: async () => ({ elementsPath: "lane-elements.json" })
  };
}

describe("computer-e2e control lane", () => {
  test("case timeout aborts the runtime batch before its later actions", async () => {
    const fixture = await createE2ELaneRuntimeFixture({ keyDelayMs: 100 });
    const events: WorkerEvent[] = [];
    const contextTarget = fixture.target;
    try {
      const suite: Suite = {
        apiVersion: 1,
        id: "lane-case-cancellation",
        name: "lane case cancellation",
        afterAll: async () => {
          // Give the first fake native call time to settle after the case
          // deadline. A later action must still not be dispatched while this
          // hook is running.
          await sleep(250);
        },
        tests: [
          {
            id: "batch-stops",
            name: "batch stops after case abort",
            timeoutMs: 25,
            async run(context) {
              await context.computer.batch(contextTarget, {
                actions: [
                  { kind: "key", key: "first" },
                  { kind: "key", key: "second" },
                  { kind: "key", key: "third" }
                ],
                maxActions: 3
              });
            }
          }
        ]
      };
      // Keep the suite body independent of a global or worker-wide signal;
      // runSuite must supply the owning case signal through its guard.
      const result = await runSuite(suite, contextFor(fixture), (event) => events.push(event));
      expect(result.cases[0]?.status).toBe("interrupted");
      expect(result.cases[0]?.reason).toMatch(/timed out after 25ms/);
      expect(fixture.keyCalls).toEqual(["first"]);
      expect(fixture.keyCalls).not.toContain("second");
      expect(fixture.keyCalls).not.toContain("third");
      expect(events.some((event) => event.type === "case_finished")).toBe(true);
    } finally {
      await fixture.close();
    }
  }, 10_000);

  test("runSuite closes the real observation-store to point-click loop", async () => {
    const fixture = await createE2ELaneRuntimeFixture();
    try {
      const contextTarget: Target = fixture.target;
      const result = await runSuite(
        {
          apiVersion: 1,
          id: "lane-observe-point-click",
          name: "lane observe point click",
          tests: [
            {
              id: "closed-loop",
              name: "observe then point click",
              async run(context) {
                const observation = await context.computer.observe(contextTarget, { mode: "both" });
                expect(observation.image.status).toBe("usable");
                expect(observation.image.geometry).toBeDefined();
                await context.computer.clickPoint(contextTarget, {
                  observationId: observation.id,
                  x: 320,
                  y: 200
                });
              }
            }
          ]
        },
        contextFor(fixture),
        () => undefined
      );
      expect(result.cases[0]?.status).toBe("passed");
      expect(result.errors).toEqual([]);
      expect(fixture.pointClicks).toEqual([{ x: 320, y: 200 }]);
      expect(fixture.observeRequests).toEqual([
        { accessibility: true, screenshot: true },
        { accessibility: false, screenshot: true }
      ]);
    } finally {
      await fixture.close();
    }
  }, 10_000);
});
