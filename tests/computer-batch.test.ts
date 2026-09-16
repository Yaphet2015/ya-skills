import { describe, expect, test } from "bun:test";
import { validateBatch, runBatch, DEFAULT_MAX_ACTIONS, MAX_ACTIONS_LIMIT } from "../packages/computer-runtime/src/batch.js";
import { ComputerError } from "../packages/computer-runtime/src/session.js";
import type { ActionReceipt, BatchRequest, BatchResult, Computer, Observation, Target } from "../packages/computer-runtime/src/types.js";
import { makeNativeObservation, FIXTURE_TARGET } from "./helpers/computer-fixtures.js";
import { projectObservation } from "../packages/computer-runtime/src/observe.js";

const target: Target = FIXTURE_TARGET;

// Full fake Computer: every method overridable; observe counted separately.
function fakeComputer(overrides: Partial<Computer> = {}): Computer & { observeCount: number } {
  let observeCount = 0;
  const defaultObserve: Computer["observe"] = async (_t, options) => {
    const raw = makeNativeObservation();
    return projectObservation(raw, options ?? {}, { accessibility: true, screenshot: false });
  };
  const base: Computer = {
    apps: async () => [],
    windows: async () => [],
    snapshot: async () => ({ elements: [], title: "" }),
    observe: defaultObserve,
    clickPoint: async () => undefined,
    batch: async () => ({ status: "completed", steps: [] }) as BatchResult,
    click: async () => undefined,
    setValue: async () => ({ route: "accessibility", effect: "confirmed" }),
    type: async () => undefined,
    key: async () => undefined,
    scroll: async () => undefined,
    waitFor: async () => []
  };
  const merged: Computer = { ...base, ...overrides };
  // observe counting wraps whichever implementation is active so overrides
  // stay observable.
  const originalObserve = merged.observe.bind(merged);
  merged.observe = async (t, options) => {
    observeCount++;
    return originalObserve(t, options);
  };
  const counted = merged as Computer & { observeCount: number };
  Object.defineProperty(counted, "observeCount", {
    get: () => observeCount,
    enumerable: true
  });
  return counted;
}

describe("validateBatch (full pre-validation, no driver side effects)", () => {
  test("the third step being invalid rejects the whole batch", () => {
    expect(() =>
      validateBatch({
        actions: [
          { kind: "type", text: "a" },
          { kind: "key", key: "Return" },
          { kind: "type", text: 42 as never }
        ]
      })
    ).toThrow(/actions\[2\]/);
  });

  test("default limit is 5 actions; explicit maxActions raises to the cap of 20", () => {
    const many = (n: number) => Array.from({ length: n }, () => ({ kind: "key", key: "Tab" }));
    expect(() => validateBatch({ actions: many(6) })).toThrow(/limit is 5/);
    expect(() => validateBatch({ actions: many(6), maxActions: 10 })).not.toThrow();
    expect(() => validateBatch({ actions: many(21), maxActions: 20 })).toThrow(/limit is 20/);
    expect(DEFAULT_MAX_ACTIONS).toBe(5);
    expect(MAX_ACTIONS_LIMIT).toBe(20);
  });

  test.each([
    [{ actions: [] }, /non-empty/],
    [{ actions: [{ kind: "explode" }] }, /kind/],
    [{ actions: [{ kind: "type", text: "" }] }, /text/],
    [{ actions: [{ kind: "set_value", elementToken: "", value: "x" }] }, /elementToken/],
    [{ actions: [{ kind: "key", key: "Return", modifiers: [5] }] }, /modifiers/],
    [{ actions: [{ kind: "scroll", spec: { direction: "sideways", amount: 1, x: 0, y: 0 } }] }, /direction/],
    [{ actions: [{ kind: "wait", condition: { kind: "window_exists" }, timeoutMs: 0 }] }, /timeoutMs/],
    [{ actions: [{ kind: "click_point", point: { observationId: "nope", x: 1, y: 1 } }] }, /observationId/],
    [{ actions: [{ kind: "click_point", point: { observationId: "01234567-89ab-cdef-0123-456789abcdef", x: -1, y: 1 } }] }, /non-negative/],
    [{ actions: [{ kind: "key", key: "A" }], timeoutMs: 999_999 }, /timeoutMs/]
  ])("invalid request %j is rejected with %s", (request, pattern) => {
    expect(() => validateBatch(request)).toThrow(pattern as RegExp);
  });
});

describe("runBatch (serial execution with partial receipts)", () => {
  test("the plan's reference case: unknown delivery stops the batch, no replay", async () => {
    const order: string[] = [];
    const computer = fakeComputer({
      type: async () => {
        order.push("type");
      },
      key: async () => {
        order.push("key");
        throw new ComputerError("command_timeout", "key timeout", "unknown");
      }
    });
    const result = await runBatch(computer, target, {
      actions: [
        { kind: "type", text: "abc" },
        { kind: "key", key: "Return" },
        { kind: "type", text: "must not run" }
      ]
    });
    expect(order).toEqual(["type", "key"]);
    expect(result.steps.map((s) => s.status)).toEqual(["delivered", "unknown", "not_run"]);
    expect(result.status).toBe("interrupted");
  });

  test("a known refusal fails the batch but keeps earlier receipts", async () => {
    const computer = fakeComputer({
      type: async () => undefined,
      key: async () => {
        throw new ComputerError("action_refused", "refused by driver", "not_delivered");
      }
    });
    const result = await runBatch(computer, target, {
      actions: [
        { kind: "type", text: "abc" },
        { kind: "key", key: "Return" },
        { kind: "key", key: "Tab" }
      ]
    });
    expect(result.status).toBe("failed");
    expect(result.steps.map((s) => s.status)).toEqual(["delivered", "not_delivered", "not_run"]);
  });

  test("set_value is a distinct AX-only batch action", async () => {
    const calls: Array<{ token: string; value: string }> = [];
    const computer = fakeComputer({
      setValue: async (_target, elementToken, value) => {
        calls.push({ token: elementToken, value });
        return { route: "accessibility", effect: "confirmed" };
      }
    });
    const result = await runBatch(computer, target, {
      actions: [{ kind: "set_value", elementToken: "field-token", value: "Ada" }]
    });
    expect(calls).toEqual([{ token: "field-token", value: "Ada" }]);
    expect(result).toMatchObject({ status: "completed", steps: [{ kind: "set_value", status: "delivered" }] });
  });

  test("two normal steps produce exactly ONE final observation", async () => {
    const computer = fakeComputer({
      type: async () => undefined,
      key: async () => undefined
    });
    const result = await runBatch(computer, target, {
      actions: [
        { kind: "type", text: "abc" },
        { kind: "key", key: "Return" }
      ],
      observe: { mode: "auto" }
    });
    expect(computer.observeCount).toBe(1);
    expect(result.status).toBe("completed");
    expect(result.observation).toBeTruthy();
    expect(result.observationError).toBeUndefined();
  });

  test("click's internal AX lookup is not counted as an LLM observation", async () => {
    const computer = fakeComputer({
      click: async () => undefined
    });
    const result = await runBatch(computer, target, { actions: [{ kind: "click", selector: { text: "OK", match: "exact" } }] });
    expect(computer.observeCount).toBe(0);
    expect(result.status).toBe("completed");
  });

  test("a failed final observation keeps delivered receipts", async () => {
    const computer = fakeComputer({
      type: async () => undefined,
      observe: async () => {
        throw new ComputerError("degraded_snapshot", "window occluded");
      }
    });
    const result = await runBatch(computer, target, {
      actions: [{ kind: "type", text: "abc" }],
      observe: { mode: "auto" }
    });
    expect(result.status).toBe("completed");
    expect(result.steps[0]!.status).toBe("delivered");
    expect(result.observationError?.code).toBe("degraded_snapshot");
  });

  test("cancellation during final observation interrupts without claiming completion", async () => {
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => (startedResolve = resolve));
    let releaseResolve!: () => void;
    const pending = new Promise<void>((resolve) => (releaseResolve = resolve));
    const computer = fakeComputer({
      type: async () => undefined,
      observe: async () => {
        startedResolve();
        await pending;
        const raw = makeNativeObservation();
        return projectObservation(raw, { mode: "ax" }, { accessibility: true, screenshot: false });
      }
    });
    const controller = new AbortController();
    const running = runBatch(
      computer,
      target,
      { actions: [{ kind: "type", text: "abc" }], observe: { mode: "auto" } },
      controller.signal
    );
    await started;
    controller.abort();
    releaseResolve();
    const result = await running;
    expect(result.status).toBe("interrupted");
    expect(result.steps[0]?.status).toBe("delivered");
    expect(result.observationError?.code).toBe("request_cancelled");
  });

  test("wait polls local AX until the condition is met, without LLM turns", async () => {
    let polls = 0;
    const computer = fakeComputer({
      observe: async () => {
        polls++;
        const raw = makeNativeObservation({
          elements: [
            { elementIndex: 1n, role: "AXStaticText", label: "Done", depth: 1 }
          ],
          totalElementCount: 1n,
          returnedElementCount: 1n
        });
        return projectObservation(raw, { mode: "ax" }, { accessibility: true, screenshot: false });
      }
    });
    const result = await runBatch(
      computer,
      target,
      { actions: [{ kind: "wait", condition: { kind: "element_exists", selector: { text: "Done", match: "exact" } }, timeoutMs: 2_000 }] },
      undefined,
      { sleep: async () => undefined, now: () => Date.now() }
    );
    expect(result.status).toBe("completed");
    expect(result.steps[0]!.status).toBe("satisfied");
    expect(polls).toBeGreaterThanOrEqual(1);
  });

  test("wait timing out fails the batch with condition_timeout", async () => {
    const computer = fakeComputer();
    let t = 0;
    const result = await runBatch(
      computer,
      target,
      { actions: [{ kind: "wait", condition: { kind: "element_exists", selector: { text: "Never", match: "exact" } }, timeoutMs: 1_000 }] },
      undefined,
      { sleep: async () => undefined, now: () => (t += 400) }
    );
    expect(result.status).toBe("failed");
    expect(result.steps[0]!.status).toBe("not_delivered");
    expect(result.steps[0]!.error?.code).toBe("condition_timeout");
  });

  test("focused_element before-conditions fail with unsupported_condition, nothing delivered", async () => {
    const delivered: string[] = [];
    const computer = fakeComputer({
      type: async (_t, text) => {
        delivered.push(text);
      }
    });
    const result = await runBatch(computer, target, {
      actions: [
        { kind: "type", text: "x", before: { kind: "focused_element", selector: { text: "Search", match: "exact" } } }
      ]
    });
    expect(delivered).toEqual([]);
    expect(result.status).toBe("failed");
    expect(result.steps[0]!.error?.code).toBe("unsupported_condition");
  });

  test("a satisfied before-condition lets the step run", async () => {
    const delivered: string[] = [];
    const computer = fakeComputer({
      observe: async () => {
        const raw = makeNativeObservation({
          elements: [{ elementIndex: 1n, role: "AXTextField", label: "Search", depth: 1 }]
        });
        return projectObservation(raw, { mode: "ax" }, { accessibility: true, screenshot: false });
      },
      type: async (_t, text) => {
        delivered.push(text);
      }
    });
    const result = await runBatch(computer, target, {
      actions: [
        { kind: "type", text: "penguin", before: { kind: "element_exists", selector: { text: "Search", match: "exact" } } }
      ]
    });
    expect(delivered).toEqual(["penguin"]);
    expect(result.status).toBe("completed");
  });

  test("the overall deadline interrupts before later steps", async () => {
    const computer = fakeComputer();
    let t = 0;
    const result = await runBatch(
      computer,
      target,
      { actions: [{ kind: "key", key: "A" }, { kind: "key", key: "B" }], timeoutMs: 1 },
      undefined,
      { sleep: async () => undefined, now: () => (t += 1) }
    );
    expect(result.status).toBe("interrupted");
    expect(result.steps.every((s) => s.status === "not_run")).toBe(true);
  });

  test("aborting the signal stops before the next step", async () => {
    const controller = new AbortController();
    controller.abort();
    const computer = fakeComputer({ key: async () => undefined });
    const result = await runBatch(computer, target, { actions: [{ kind: "key", key: "A" }] }, controller.signal);
    expect(result.status).toBe("interrupted");
    expect(result.steps[0]!.status).toBe("not_run");
  });

  test("click_point steps flow through computer.clickPoint", async () => {
    const points: unknown[] = [];
    const computer = fakeComputer({
      clickPoint: async (_t, point) => {
        points.push(point);
      }
    });
    const result = await runBatch(computer, target, {
      actions: [{ kind: "click_point", point: { observationId: "01234567-89ab-cdef-0123-456789abcdef", x: 10, y: 20 } }]
    });
    expect(points).toEqual([{ observationId: "01234567-89ab-cdef-0123-456789abcdef", x: 10, y: 20 }]);
    expect(result.steps.map((s: ActionReceipt) => s.kind)).toEqual(["click_point"]);
    expect(result.status).toBe("completed");
  });
});

describe("batch request typing through JSON (wire shape)", () => {
  test("a request parsed from JSON validates identically", () => {
    const json = JSON.stringify({
      actions: [
        { kind: "click", selector: { text: "Save", match: "exact", role: "AXButton" } },
        { kind: "type", text: "hello" },
        { kind: "wait", condition: { kind: "element_exists", selector: { text: "Saved", match: "contains" } }, timeoutMs: 3000 }
      ],
      observe: { mode: "auto" },
      timeoutMs: 20000
    });
    const request = validateBatch(JSON.parse(json));
    expect(request.actions).toHaveLength(3);
    expect(request.observe?.mode).toBe("auto");
  });
});
