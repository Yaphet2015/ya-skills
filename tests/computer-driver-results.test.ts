import { describe, expect, test } from "bun:test";
import { createSessionWithBackend } from "../packages/computer-runtime/src/session.js";
import { fakeBackendFactory, FIXTURE_TARGET } from "./helpers/computer-fixtures.js";
import { makeBackend } from "../packages/computer-runtime/src/cua-backend.js";
import { parseActionResult } from "../packages/computer-runtime/src/driver-result.js";
import { createComputerUseCommands } from "../packages/functions-computer-use/src/commands.js";
import { parseRequest } from "../packages/functions-computer-use/src/args.js";
import { createScriptComputer } from "../packages/computer-session/src/script-computer.js";
import { createExecDispatch } from "../packages/computer-session/src/exec-dispatch.js";
import { decodeBatchResultValue, decodeRequest } from "../packages/computer-session/src/protocol.js";
import { makeNativeObservation } from "./helpers/computer-fixtures.js";
import type { ActionResult, NativeInputAddress } from "../packages/computer-runtime/src/types.js";
import type { JsonValue } from "../packages/computer-session/src/exec-types.js";
const action = {
  route: "synthetic_events",
  effect: "unverifiable",
  delivery: { mode: "background" },
  escalation: { target: "foreground", reason: "delivery_failed" }
};

describe("driver action results reach callers", () => {
  test("a native unverified background result survives the batch receipt", async () => {
    const session = createSessionWithBackend({
      load: async () => ({}),
      create: fakeBackendFactory({ type: async () => ({ isError: false, structuredJson: JSON.stringify(action) }) })
    });
    try {
      const result = await session.computer.batch(FIXTURE_TARGET, { actions: [{ kind: "type", text: "hello" }] });
      expect(result.steps[0]).toMatchObject({ status: "delivered", result: action });
    } finally { await session.close(); }
  });

  test("a native structured refusal stops the batch without sending the next action", async () => {
    let calls = 0;
    const refusal = { route: "accessibility", effect: "refused", error: { code: "background_unavailable" } };
    const session = createSessionWithBackend({
      load: async () => ({}),
      create: fakeBackendFactory({ type: async () => {
        calls++;
        return { isError: false, structuredJson: JSON.stringify(refusal) };
      } })
    });
    try {
      const result = await session.computer.batch(FIXTURE_TARGET, {
        actions: [{ kind: "type", text: "first" }, { kind: "type", text: "second" }]
      });
      expect(result.status).toBe("failed");
      expect(result.steps[0]).toMatchObject({ status: "not_delivered", result: refusal });
      expect(result.steps[1]?.status).toBe("not_run");
      expect(calls).toBe(1);
    } finally { await session.close(); }
  });
});


const nativeResult: ActionResult = {
  route: "synthetic_events", effect: "unverifiable", delivery: { mode: "background" },
  escalation: { target: "page", reason: "effect_unconfirmed" }
};

test("the SDK adapter sends explicit background input to the exact field or point in one call", async () => {
  const calls: { name: string; json: string }[] = [];
  const backend = makeBackend({} as never, {
    callTool: async (name: string, json: string) => { calls.push({ name, json }); return { structuredJson: JSON.stringify(nativeResult) }; }
  } as never);
  const target = { pid: 42, windowId: 9007199254740993n };
  await backend.type(target, 'quoted "text"', { elementToken: "s00000001:2" });
  await backend.key(target, "Return", ["cmd"], { point: { x: 24, y: 36 } });
  await backend.scroll(target, { direction: "down", amount: 2, x: 10, y: 20 });
  expect(calls).toHaveLength(3);
  for (const call of calls) {
    expect(call.json).toContain('"window_id":9007199254740993');
    expect(JSON.parse(call.json)).toMatchObject({ target: { kind: "window", pid: 42 }, delivery_mode: "background" });
  }
  expect(calls[0]?.name).toBe("type_text");
  expect(JSON.parse(calls[0]!.json)).toMatchObject({ text: 'quoted "text"', element_token: "s00000001:2" });
  expect(calls[1]?.name).toBe("press_key");
  expect(JSON.parse(calls[1]!.json)).toMatchObject({ key: "Return", modifiers: ["cmd"], x: 24, y: 36 });
});

test("typed click enums retain their route, effect, refusal and escalation", () => {
  expect(parseActionResult({ route: 1, effect: 2, delivery: { mode: 0, deliveredCount: 2 }, escalation: { target: 2, reason: 2 } })).toEqual({
    ...nativeResult, delivery: { mode: "background", deliveredCount: 2 }
  });
  expect(parseActionResult({ action: { route: 0, effect: 4, error: { code: "background_unavailable" } } })).toMatchObject({
    route: "accessibility", effect: "refused", error: { code: "background_unavailable" }
  });
  expect(() => parseActionResult({ route: 100, effect: 0 })).toThrow("invalid driver route");
});

test("CLI parses input addressing and rejects incomplete or conflicting targets", () => {
  const base = ["--pid", "42", "--type", "hello"];
  expect(parseRequest("act", [...base, "--element-token", "s00000001:2"])).toMatchObject({ input: { elementToken: "s00000001:2" } });
  const point = ["--input-x", "12", "--input-y", "34", "--observation", "11111111-1111-4111-8111-111111111111"];
  expect(parseRequest("act", [...base, ...point])).toMatchObject({ input: { point: { x: 12, y: 34 } } });
  expect(() => parseRequest("act", [...base, "--input-x", "1"])).toThrow("input coordinates require");
  expect(() => parseRequest("act", [...base, "--element-token", "token", ...point])).toThrow("exclusive");
});

test("one-shot CLI preserves driver metadata in both output formats and forwards the field", async () => {
  const inputs: Array<NativeInputAddress | undefined> = [];
  const commands = createComputerUseCommands({ createSession: () => createSessionWithBackend({
    load: async () => ({}),
    create: fakeBackendFactory({
      windows: async () => [{ ...FIXTURE_TARGET, title: "fixture" }],
      snapshot: async () => ({ title: "fixture", elements: [] }),
      observe: async () => makeNativeObservation(),
      type: async (_target, _text, input) => { inputs.push(input); return { structuredJson: JSON.stringify(nativeResult) }; }
    })
  }) });
  const act = commands.find((command) => command.action === "act")!;
  for (const format of ["legacy", "observation"]) {
    const output = JSON.parse(String(await act.run(["--pid", String(FIXTURE_TARGET.pid), "--type", "hello", "--element-token", "field", "--format", format])));
    expect(output.actionResult).toEqual(nativeResult);
  }
  expect(inputs).toEqual([{ elementToken: "field" }, { elementToken: "field" }]);
});

test("script input and result cross the host dispatcher and protocol without being dropped", async () => {
  const inputs: Array<NativeInputAddress | undefined> = [];
  const session = createSessionWithBackend({
    load: async () => ({}),
    create: fakeBackendFactory({ type: async (_target, _text, input) => { inputs.push(input); return { structuredJson: JSON.stringify(nativeResult) }; } })
  });
  const dispatch = createExecDispatch({
    driverSupportsStep: true,
    driverCall: async (_method, args) => session.executeStep!(FIXTURE_TARGET, args.action as never, { index: args.index as number })
  }, {
    runDeadlineAt: Date.now() + 10_000,
    dispatchSignal: new AbortController().signal,
    requestAborted: () => false,
    runAdmissionError: () => null,
    markUnknownDelivery: () => { throw new Error("unexpected unknown delivery"); },
    observationLimit: () => {}
  });
  const computer = createScriptComputer(async (method, args) => await dispatch.run(0, method, args) as JsonValue);
  try {
    expect(await computer.type("hello", undefined, { elementToken: "field" })).toEqual(nativeResult);
    expect(inputs).toEqual([{ elementToken: "field" }]);
    const result = decodeBatchResultValue({ status: "completed", steps: dispatch.receipts });
    expect(result.steps[0]?.result).toEqual(nativeResult);
  } finally { await session.close(); }
});


test("session wire requests retain input addressing", () => {
  const input = { elementToken: "s00000001:2" };
  const request = decodeRequest(JSON.stringify({
    schemaVersion: 1, sessionId: "session", generation: "generation", requestId: "input-1",
    operation: { kind: "batch", request: { actions: [{ kind: "type", text: "hello", input }] } }
  }));
  expect(request.operation).toMatchObject({ request: { actions: [{ kind: "type", text: "hello", input }] } });
});


test("refused is preserved even when the SDK wrapper also sets isError", async () => {
  const result = { route: "accessibility", effect: "refused", error: { code: "background_unavailable" } };
  const session = createSessionWithBackend({
    load: async () => ({}),
    create: fakeBackendFactory({ type: async () => ({ isError: true, structuredJson: JSON.stringify(result) }) })
  });
  try {
    const batch = await session.computer.batch(FIXTURE_TARGET, { actions: [{ kind: "type", text: "hello" }] });
    expect(batch.steps[0]).toMatchObject({ status: "not_delivered", result });
  } finally { await session.close(); }
});

test("AX setValue proof survives batch receipts", async () => {
  const result = { route: "accessibility", effect: "confirmed", delivery: { mode: "not_applicable", delivered_count: 1 } };
  const session = createSessionWithBackend({
    load: async () => ({}),
    create: fakeBackendFactory({ setValue: async () => ({ structuredJson: JSON.stringify(result) }) })
  });
  try {
    const batch = await session.computer.batch(FIXTURE_TARGET, { actions: [{ kind: "set_value", elementToken: "token", value: "hello" }] });
    expect(batch.steps[0]).toMatchObject({ status: "delivered", result: {
      route: "accessibility", effect: "confirmed", delivery: { mode: "not_applicable", deliveredCount: 1 }
    } });
  } finally { await session.close(); }
});


test("generic SDK error codes survive even without an ActionResult", async () => {
  const session = createSessionWithBackend({
    load: async () => ({}),
    create: fakeBackendFactory({ type: async () => ({ isError: true, errorCode: "background_unavailable" }) })
  });
  try {
    await expect(session.computer.type(FIXTURE_TARGET, "hello")).rejects.toMatchObject({
      code: "background_unavailable", actionOutcome: "not_delivered"
    });
  } finally { await session.close(); }
});
