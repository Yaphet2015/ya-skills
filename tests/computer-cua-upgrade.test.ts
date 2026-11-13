import { describe, expect, test } from "bun:test";
import { createSessionWithBackend } from "../packages/computer-runtime/src/session.js";
import { normalizeElements, projectObservation } from "../packages/computer-runtime/src/observe.js";
import { evaluateCondition } from "../packages/computer-runtime/src/conditions.js";
import { makeBackend } from "../packages/computer-runtime/src/cua-backend.js";
import { decodeWindowState } from "../packages/computer-runtime/src/cua-window-state.js";
import { sanitizeElements } from "../packages/computer-runtime/src/observe.js";
import { validateBatch } from "../packages/computer-runtime/src/batch.js";
import { decodeObservationValue, decodeRequest, encodeRequest } from "../packages/computer-session/src/protocol.js";
import { createExecDispatch } from "../packages/computer-session/src/exec-dispatch.js";
import { createScriptComputer } from "../packages/computer-session/src/script-computer.js";
import type { JsonValue } from "../packages/computer-session/src/exec-types.js";
import { fakeBackendFactory, FIXTURE_TARGET, makeNativeObservation } from "./helpers/computer-fixtures.js";

describe("Cua multi-step execution", () => {
  test("batch and hosted steps skip report waits without changing direct actions", async () => {
    const options: unknown[] = [];
    const session = createSessionWithBackend({
      load: async () => ({}),
      create: fakeBackendFactory({ type: async (...args: unknown[]) => {
        options.push(args[3]);
        return { isError: false };
      } })
    });
    try {
      await session.computer.type(FIXTURE_TARGET, "direct");
      const batch = await session.computer.batch(FIXTURE_TARGET, {
        actions: [{ kind: "type", text: "first" }, { kind: "type", text: "second" }]
      });
      expect(batch.status).toBe("completed");
      expect((await session.executeStep!(FIXTURE_TARGET, { kind: "type", text: "hosted" })).status).toBe("completed");
      await session.computer.type(FIXTURE_TARGET, "direct again");
      expect(options).toEqual([undefined, { postActionWait: "none" }, { postActionWait: "none" }, { postActionWait: "none" }, undefined]);
    } finally { await session.close(); }
  });

  test("a refused fast step stops later input and restores direct-call behavior", async () => {
    const options: unknown[] = [];
    const session = createSessionWithBackend({
      load: async () => ({}),
      create: fakeBackendFactory({ type: async (...args: unknown[]) => {
        options.push(args[3]);
        return options.length === 1
          ? { structuredJson: JSON.stringify({ route: "accessibility", effect: "refused", error: { code: "background_unavailable" } }) }
          : { isError: false };
      } })
    });
    try {
      const batch = await session.computer.batch(FIXTURE_TARGET, {
        actions: [{ kind: "type", text: "refused" }, { kind: "type", text: "must not run" }]
      });
      expect(batch.steps.map(step => step.status)).toEqual(["not_delivered", "not_run"]);
      await session.computer.type(FIXTURE_TARGET, "new direct action");
      expect(options).toEqual([{ postActionWait: "none" }, undefined]);
    } finally { await session.close(); }
  });
});

describe("actionable AX projections", () => {
  const condition = { kind: "element_exists", selector: { text: "Search", match: "exact" } } as const;
  const element = { role: "AXTextField", label: "Search", value: "penguin", elementToken: "fresh:1" };

  test("an actionable projection supports a positive wait without claiming completeness", () => {
    const view = projectObservation(makeNativeObservation({ elements: [element], elementsComplete: false }), { mode: "ax" });
    expect(view.ax.status).toBe("usable");
    expect(view.ax.complete).toBe(false);
    expect(evaluateCondition(condition, view)).toBe(true);
    expect(evaluateCondition({ kind: "element_value", selector: condition.selector, value: "penguin" }, view)).toBe(true);
  });

  test("missing, duplicate, degraded and truncated matches do not satisfy readiness", () => {
    for (const overrides of [
      { elements: [] },
      { elements: [element, { ...element, elementToken: "fresh:2" }] },
      { elements: [element], degraded: true },
      { elements: [element], truncated: true },
      { elements: [element], totalElementCount: 10n, returnedElementCount: 1n }
    ]) {
      const view = projectObservation(makeNativeObservation({ elementsComplete: false, ...overrides }), { mode: "ax" });
      expect(evaluateCondition(condition, view)).toBe(false);
    }
  });

  test("native search identity and selected state survive normalization", () => {
    const [field] = normalizeElements([{ ...element, title: "Global search", description: "Find notes", placeholder: "Search notes", subrole: "AXSearchField", selected: true }]);
    expect(field).toMatchObject({ title: "Global search", description: "Find notes", placeholder: "Search notes", subrole: "AXSearchField", selected: true });
  });
});

const rawElement = {
  role: "AXTextField", label: "Input", title: "Global search", description: "Find notes",
  placeholder: "Search notes", subrole: "AXSearchField", element_token: "fresh:1", value: "", selected: true, enabled: true
};
const actionResult = { route: "synthetic_events", effect: "unverifiable", delivery: { mode: "background" } } as const;

function nativeState(target = FIXTURE_TARGET, value = "") {
  return `{"pid":${target.pid},"window_id":${target.windowId},"window_title":"Fixture","elements_complete":false,"total_element_count":1,"returned_element_count":1,"elements":${JSON.stringify([{ ...rawElement, value }])}}`;
}

describe("Cua generic native contract", () => {
  test("a generic fast click with uncertain delivery stops the batch and poisons the session", async () => {
    let clicks = 0;
    const backend = makeBackend({ EndSessionInput: { new: () => ({}) } } as never, {
      callTool: async (name: string) => {
        if (name === "get_window_state") return { structuredJson: nativeState() };
        clicks++;
        return { isError: true, errorCode: "native_timeout" };
      },
      metadata: async () => ({}), endSession: async () => undefined, shutdown: async () => undefined
    } as never, () => undefined);
    const session = createSessionWithBackend({ load: async () => ({}), create: async () => backend });
    try {
      const result = await session.computer.batch(FIXTURE_TARGET, {
        actions: [
          { kind: "click", selector: { text: "Search notes", match: "exact", subrole: "AXSearchField" } },
          { kind: "type", text: "must not run" }
        ]
      });
      expect(result.status).toBe("interrupted");
      expect(result.steps.map(step => step.status)).toEqual(["unknown", "not_run"]);
      expect(clicks).toBe(1);
      await expect(session.computer.type(FIXTURE_TARGET, "must also not run")).rejects.toMatchObject({ code: "session_unusable" });
    } finally { await session.close(); }
  });

  test("multi-step native actions carry the new option with exact targets and AX-only writes", async () => {
    const calls: Array<{ name: string; body: string }> = [];
    const backend = makeBackend({} as never, {
      callTool: async (name: string, body: string) => {
        calls.push({ name, body });
        return { structuredJson: JSON.stringify(actionResult) };
      }
    } as never);
    const target = { pid: 42, windowId: 9007199254740993n };
    const options = { postActionWait: "none" } as const;
    await backend.clickToken(target, "fresh:1", options);
    await backend.clickPoint(target, { x: 12, y: 34 }, options);
    await backend.type(target, 'quoted "text"', { elementToken: "fresh:1" }, options);
    await backend.key(target, "Return", undefined, { elementToken: "fresh:1" }, options);
    await backend.scroll(target, { direction: "down", amount: 2, x: 10, y: 20 }, options);
    await backend.setValue!(target, "fresh:1", "AX only", options);
    expect(calls.map(call => call.name)).toEqual(["click", "click", "type_text", "press_key", "scroll", "set_value"]);
    for (const call of calls) {
      expect(JSON.parse(call.body).post_action_wait).toBe("none");
      if (call.name !== "set_value") {
        expect(call.body).toContain('"window_id":9007199254740993');
        expect(JSON.parse(call.body).delivery_mode).toBe("background");
      }
    }
    expect(JSON.parse(calls[5]!.body)).toEqual({ pid: 42, element_token: "fresh:1", value: "AX only", post_action_wait: "none" });
  });

  test("window reads preserve native identity, image metadata, bigint IDs and cancellation", async () => {
    const target = { pid: 42, windowId: 9007199254740993n };
    const controller = new AbortController();
    const calls: Array<{ body: string; options: unknown }> = [];
    const backend = makeBackend({} as never, {
      callTool: async (_name: string, body: string, options: unknown) => {
        calls.push({ body, options });
        return {
          structuredJson: nativeState(target).replace(/}$/, ',"screenshot_width":640,"screenshot_height":400,"screenshot_scale":2,"screenshot_frame_valid":true,"window_bounds":{"x":10,"y":20,"width":320,"height":200}}'),
          images: [{ mimeType: "image/png", dataBase64: "fixture-image" }]
        };
      }
    } as never, () => undefined);
    const raw = await backend.observe(target, { accessibility: true, screenshot: true }, { signal: controller.signal });
    expect(raw.windowId).toBe(target.windowId);
    expect(raw.windowBounds).toEqual({ x: 10, y: 20, width: 320, height: 200 });
    expect(raw.images?.[0]?.dataBase64).toBe("fixture-image");
    expect(normalizeElements(raw.elements)[0]).toMatchObject({
      title: "Global search", description: "Find notes", placeholder: "Search notes",
      subrole: "AXSearchField", elementToken: "fresh:1", selected: true
    });
    expect(calls[0]!.options).toEqual({ signal: controller.signal });
    expect(calls[0]!.body).toContain('"window_id":9007199254740993');
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ full_output: true, screenshot_format: "png" });
  });

  test("malformed or mismatched native window results fail before publication", () => {
    for (const structuredJson of ["{}", "null", "broken", nativeState({ ...FIXTURE_TARGET, windowId: 999n }), nativeState().replace('"elements_complete":false', '"elements_complete":"false"')]) {
      expect(() => decodeWindowState({ structuredJson }, FIXTURE_TARGET)).toThrow("invalid window metadata");
    }
    expect(() => decodeWindowState({ isError: true, errorCode: "ax_window_unresolved" }, FIXTURE_TARGET)).toThrow("refused");
  });

  test("raw AX fields reach exec, selectors and waits without a screenshot fallback", async () => {
    let value = "";
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const backend = makeBackend({ EndSessionInput: { new: () => ({}) } } as never, {
      callTool: async (name: string, body: string) => {
        const args = JSON.parse(body);
        calls.push({ name, args });
        if (name === "get_window_state") return { structuredJson: nativeState(FIXTURE_TARGET, value) };
        if (name === "type_text") value = args.text;
        return { structuredJson: JSON.stringify(actionResult) };
      },
      metadata: async () => ({}), endSession: async () => undefined, shutdown: async () => undefined
    } as never, () => undefined);
    const session = createSessionWithBackend({ load: async () => ({}), create: async () => backend });
    const dispatch = createExecDispatch({
      driverSupportsStep: true,
      driverCall: async (method, args, signal) => method === "observe"
        ? session.computer.observe(FIXTURE_TARGET, args.options as never, { signal, deadlineAt: args.deadlineAt as number })
        : session.executeStep!(FIXTURE_TARGET, args.action as never, { signal, index: args.index as number, deadlineAt: args.deadlineAt as number })
    }, {
      runDeadlineAt: Date.now() + 3000, dispatchSignal: new AbortController().signal,
      requestAborted: () => false, runAdmissionError: () => null,
      markUnknownDelivery: () => { throw new Error("unexpected unknown delivery"); }, observationLimit: () => {}
    });
    const computer = createScriptComputer(async (method, args) => await dispatch.run(dispatch.receipts.length, method, args) as JsonValue);
    try {
      const initial = decodeObservationValue(await computer.observe({ mode: "auto" }));
      expect(initial.ax).toMatchObject({ status: "usable", complete: false });
      expect(initial.ax.elements[0]).toMatchObject({
        title: "Global search", description: "Find notes", placeholder: "Search notes", subrole: "AXSearchField", selected: true
      });
      const selector = { text: "Search notes", match: "exact", role: "AXTextField", subrole: "AXSearchField" } as const;
      expect(validateBatch({ actions: [{ kind: "click", selector }] }).actions[0]).toEqual({ kind: "click", selector });
      const request = { schemaVersion: 1, sessionId: "s", generation: "g", requestId: "r", operation: { kind: "batch", request: { actions: [{ kind: "click", selector }] } } };
      expect(decodeRequest(encodeRequest(request as never)).operation).toMatchObject(request.operation);
      await computer.type("penguin", undefined, { elementToken: initial.ax.elements[0]!.elementToken! });
      await computer.wait({ kind: "element_value", selector, value: "penguin" }, 500);
      expect(dispatch.receipts.map(receipt => receipt.status)).toEqual(["delivered", "satisfied"]);
      expect(dispatch.receipts[0]?.result).toEqual(actionResult);
      expect(calls.filter(call => call.name === "get_window_state").every(call => call.args.include_screenshot === false)).toBe(true);
      expect(calls.find(call => call.name === "type_text")?.args.post_action_wait).toBe("none");
    } finally { await session.close(); }
  });

  test("new identity fields do not expose secure field values", () => {
    const elements = normalizeElements([{ role: "AXTextField", subrole: "AXSecureTextField", title: "Login", value: "private" }]);
    expect(sanitizeElements(elements)[0]?.value).toBeUndefined();
  });

  test("malformed search identity and selector fields are rejected by the protocol", () => {
    const view = projectObservation(makeNativeObservation(), { mode: "ax" });
    expect(() => decodeObservationValue({ ...view, ax: { ...view.ax, elements: [{ title: 42 }] } })).toThrow();
    expect(() => validateBatch({ actions: [{ kind: "click", selector: { text: "Search", match: "exact", subrole: "" } }] })).toThrow("subrole");
    const request = {
      schemaVersion: 1, sessionId: "s", generation: "g", requestId: "r",
      operation: { kind: "batch", request: { actions: [{ kind: "click", selector: { text: "Search", match: "exact", subrole: 42 } }] } }
    };
    expect(() => decodeRequest(JSON.stringify(request))).toThrow();
  });
});
