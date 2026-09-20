import { describe, expect, test } from "bun:test";
import { reduceResultEvents, type ResultEvent } from "../packages/functions-computer-e2e/src/result-reducer.js";

describe("computer-e2e result reducer", () => {
  test("keeps runtime and history projections distinct without duplicating event state", () => {
    const events: ResultEvent[] = [
      { type: "suite_collected", payload: { file: "suite.e2e.ts", cases: [{ id: "late", name: "late" }, { id: "never", name: "never" }] } },
      { type: "case_started", payload: { file: "suite.e2e.ts", id: "late" } },
      { type: "step_started", payload: { file: "suite.e2e.ts", caseId: "late", name: "wait" } },
      { type: "case_finished", payload: { file: "suite.e2e.ts", id: "late", status: "interrupted", reason: "timed out" } }
    ];

    const runtime = reduceResultEvents(events);
    expect(runtime.suite.cases).toEqual([
      { id: "suite.e2e.ts::late", name: "late", status: "interrupted", reason: "timed out" },
      { id: "suite.e2e.ts::never", name: "never", status: "not_run" }
    ]);
    expect(runtime.suite.steps).toEqual([]);
    expect(runtime.errors).toEqual([]);

    const history = reduceResultEvents(events, {
      caseId: (file, id) => `${file ?? "<unknown>"}::${id}`,
      includeInterruptedErrors: true,
      includeOpenSteps: true
    });
    expect(history.suite.steps).toEqual([{ caseId: "suite.e2e.ts::late", name: "wait", status: "passed" }]);
    expect(history.errors).toEqual(["suite.e2e.ts::late: timed out"]);
  });
});
