import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  decodeBatchResultValue,
  decodeControlReply,
  decodeObservationValue,
  decodeRequest,
  decodeSessionReply,
  deepRestoreWindowIds,
  encodeRequest,
  ProtocolError
} from "../packages/computer-session/src/protocol.js";
import type { SessionOperation, SessionRequest } from "../packages/computer-session/src/types.js";

const OBSERVATION_ID = randomUUID();
const SESSION_ID = randomUUID();
const GENERATION = randomUUID();

function observationWire(windowId = "9007199254740993"): Record<string, unknown> {
  return {
    id: OBSERVATION_ID,
    target: { pid: 4242, windowId },
    capturedAt: 1_700_000_000_000,
    epoch: "epoch-protocol-lane",
    revision: 0,
    title: "协议窗口",
    metadata: {
      draft: { windowId: "draft" },
      numeric: { windowId: 123 }
    },
    ax: {
      status: "usable",
      elements: [
        {
          role: "AXButton",
          label: "保存",
          value: "完成",
          elementToken: "token-save",
          frame: { x: 10, y: 20, w: 80, h: 24 },
          enabled: true,
          selected: false
        }
      ],
      total: 1,
      returned: 1,
      complete: true
    },
    image: {
      status: "usable",
      originalPath: "/private/tmp/protocol-lane-original.png",
      path: "/private/tmp/protocol-lane-sent.png",
      frameValid: true,
      geometry: {
        sourceWidth: 2880,
        sourceHeight: 1800,
        sentWidth: 1440,
        sentHeight: 900,
        inputBounds: { x: 0, y: 0, width: 1440, height: 900 },
        windowBounds: { x: 80, y: 40, width: 1440, height: 900 }
      }
    }
  };
}

function observationOperation(): SessionOperation {
  return { kind: "observe", options: { mode: "both" } };
}

function execOperation(): SessionOperation {
  return {
    kind: "exec",
    code: "return 1",
    sourceName: "protocol-lane.js",
    timeoutMs: 1_000,
    maxActions: 10
  };
}

function execResultWire(): Record<string, unknown> {
  return {
    status: "completed",
    value: {
      draft: { windowId: "draft" },
      numeric: { windowId: 123 },
      numericText: { windowId: "123" },
      中文: "返回值"
    },
    stateVersion: 3,
    stateCommitted: true,
    stateHash: "a".repeat(64),
    actions: [{ index: 0, kind: "key", status: "delivered" }],
    observations: [observationWire()],
    observationsDropped: 0,
    logs: ["脚本完成"],
    metadata: { windowId: "diagnostic-id-must-stay-text" }
  };
}

function requestFor(operation: SessionRequest["operation"]): SessionRequest {
  return {
    schemaVersion: 1,
    sessionId: SESSION_ID,
    generation: GENERATION,
    requestId: "protocol-lane-request",
    operation
  };
}

describe("protocol lane deep schema validation", () => {
  test("validates every declared observation field and nested geometry", () => {
    const decoded = decodeObservationValue({
      ...observationWire(),
      target: { pid: 4242, windowId: 9007199254740993n }
    });
    expect(decoded.target.windowId).toBe(9007199254740993n);
    expect(decoded.ax.elements[0]?.frame).toEqual({ x: 10, y: 20, w: 80, h: 24 });
    expect((decoded as unknown as { metadata: { draft: { windowId: unknown } } }).metadata.draft.windowId).toBe("draft");

    const missingImage = { ...observationWire() };
    delete missingImage.image;
    expect(() => decodeSessionReply(JSON.stringify({
      schemaVersion: 1,
      requestId: "observation-missing-image",
      status: "completed",
      result: missingImage
    }), observationOperation())).toThrow(/protocol_result/);

    const badGeometry = observationWire();
    (badGeometry.image as { geometry: { sentWidth: unknown } }).geometry.sentWidth = Infinity;
    expect(() => decodeSessionReply(JSON.stringify({
      schemaVersion: 1,
      requestId: "observation-bad-geometry",
      status: "completed",
      result: badGeometry
    }), observationOperation())).toThrow(/JSON|protocol_result/);
  });

  test("restores only declared target ids and preserves arbitrary nested ids", () => {
    const decoded = decodeSessionReply(JSON.stringify({
      schemaVersion: 1,
      requestId: "exec-arbitrary-json",
      status: "completed",
      result: execResultWire()
    }), execOperation());
    const result = decoded.result as {
      value: { draft: { windowId: string }; numeric: { windowId: number }; numericText: { windowId: string }; 中文: string };
      observations: Array<{ target: { windowId: bigint } }>;
      metadata: { windowId: string };
    };
    expect(result.observations[0]!.target.windowId).toBe(9007199254740993n);
    expect(result.value).toEqual({
      draft: { windowId: "draft" },
      numeric: { windowId: 123 },
      numericText: { windowId: "123" },
      中文: "返回值"
    });
    expect(typeof result.value.draft.windowId).toBe("string");
    expect(result.metadata.windowId).toBe("diagnostic-id-must-stay-text");

    const arbitrary = { windowId: "draft", nested: [{ windowId: "123" }] };
    expect(deepRestoreWindowIds(arbitrary)).toEqual(arbitrary);
    expect((deepRestoreWindowIds(observationWire()) as { target: { windowId: bigint } }).target.windowId).toBe(9007199254740993n);
  });

  test("validates exec receipts, logs, finite counters, and observations", () => {
    const valid = decodeSessionReply(JSON.stringify({
      schemaVersion: 1,
      requestId: "exec-valid",
      status: "completed",
      result: execResultWire()
    }), execOperation());
    expect((valid.result as { actions: unknown[] }).actions).toHaveLength(1);

    const malformed = [
      { ...execResultWire(), stateVersion: -1 },
      { ...execResultWire(), stateCommitted: "yes" },
      { ...execResultWire(), actions: [{ index: 0, kind: "key", status: "maybe" }] },
      { ...execResultWire(), actions: [{ index: 0, kind: "key" }] },
      { ...execResultWire(), observations: [{ target: { pid: 1, windowId: "1" } }] },
      { ...execResultWire(), logs: ["ok", 3] },
      { ...execResultWire(), stateHash: 17 },
      { ...execResultWire(), observationsDropped: 1.5 }
    ];
    for (const [index, result] of malformed.entries()) {
      expect(() => decodeSessionReply(JSON.stringify({
        schemaVersion: 1,
        requestId: `exec-malformed-${index}`,
        status: "completed",
        result
      }), execOperation())).toThrow(ProtocolError);
    }

    const tooManyObservations = execResultWire();
    tooManyObservations.observations = Array.from({ length: 21 }, () => observationWire());
    expect(() => decodeSessionReply(JSON.stringify({
      schemaVersion: 1,
      requestId: "exec-observation-budget",
      status: "completed",
      result: tooManyObservations
    }), execOperation())).toThrow(/observations/);

    const oversizedValue = execResultWire();
    oversizedValue.value = { payload: "x".repeat(256 * 1024) };
    expect(() => decodeSessionReply(JSON.stringify({
      schemaVersion: 1,
      requestId: "exec-value-budget",
      status: "completed",
      result: oversizedValue
    }), execOperation())).toThrow(/value/);
  });

  test("validates batch receipt and optional final observation shapes", () => {
    const observation = observationWire();
    const batch = decodeBatchResultValue({
      status: "completed",
      steps: [
        { index: 0, kind: "click", status: "delivered" },
        { index: 1, kind: "wait", status: "satisfied" }
      ],
      observation: { ...observation, target: { pid: 4242, windowId: 9007199254740993n } }
    });
    expect(batch.observation?.target.windowId).toBe(9007199254740993n);

    const wireBatch = decodeSessionReply(JSON.stringify({
      schemaVersion: 1,
      requestId: "batch-wire-observation",
      status: "completed",
      result: {
        status: "completed",
        steps: [{ index: 0, kind: "click", status: "delivered" }],
        observation
      }
    }), {
      kind: "batch",
      request: { actions: [{ kind: "click", selector: { text: "保存", match: "exact" } }] }
    });
    expect((wireBatch.result as { observation: { target: { windowId: bigint } } }).observation.target.windowId).toBe(9007199254740993n);

    const malformed = [
      { status: "completed", steps: [{ index: 0, kind: "click", status: "invalid" }] },
      { status: "completed", steps: [{ index: 0, kind: "click" }] },
      { status: "completed", steps: [{ index: 0, kind: "click", status: "delivered", error: { code: 1, message: "bad" } }] },
      { status: "completed", steps: [{ index: 0, kind: "click", status: "delivered" }], observation: { ...observation, image: undefined } }
    ];
    for (const result of malformed) expect(() => decodeBatchResultValue(result)).toThrow(ProtocolError);
  });
});

describe("protocol lane request and control boundaries", () => {
  test("validates nested request actions without changing the operation contract", () => {
    const request = requestFor({
      kind: "batch",
      request: {
        actions: [
          {
            kind: "type",
            text: "你好",
            before: { kind: "element_exists", selector: { text: "保存", match: "exact", role: "AXButton" } }
          },
          { kind: "key", key: "Return", modifiers: ["cmd"] },
          { kind: "scroll", spec: { direction: "down", amount: 2, x: 10, y: 20 } }
        ],
        timeoutMs: 3_000,
        maxActions: 5,
        observe: { mode: "both", maxDimension: 800, selector: { text: "保存", match: "contains" } }
      }
    });
    expect(decodeRequest(encodeRequest(request))).toEqual(request);

    const invalidNested = [
      { ...request, operation: { kind: "batch", request: { actions: [{ kind: "key", key: "Return", modifiers: [1] }] } } },
      { ...request, operation: { kind: "batch", request: { actions: [{ kind: "scroll", spec: { direction: "diagonal", amount: 1, x: 0, y: 0 } }] } } },
      { ...request, operation: { kind: "batch", request: { actions: [{ kind: "wait", condition: { kind: "window_exists" }, timeoutMs: Infinity }] } } }
    ];
    for (const candidate of invalidNested) {
      expect(() => decodeRequest(JSON.stringify(candidate))).toThrow(ProtocolError);
    }
  });

  test("keeps SessionInfo ids as decimal strings and validates its nested wire shape", () => {
    const decoded = decodeControlReply(JSON.stringify({
      schemaVersion: 1,
      info: {
        id: SESSION_ID,
        target: { pid: 4242, windowId: "9007199254740993" },
        state: "idle",
        hostPid: 77,
        generation: GENERATION,
        idleTimeoutMs: 120_000,
        metadata: { windowId: "diagnostic-text" }
      }
    }));
    expect(decoded.info?.target.windowId).toBe("9007199254740993");
    expect((decoded.info as unknown as { metadata: { windowId: string } }).metadata.windowId).toBe("diagnostic-text");
    expect(() => decodeControlReply(JSON.stringify({
      schemaVersion: 1,
      info: {
        id: SESSION_ID,
        target: { pid: 4242, windowId: "not-decimal" },
        state: "idle",
        hostPid: 77,
        generation: GENERATION,
        idleTimeoutMs: 120_000
      }
    }))).toThrow(/protocol_control|protocol_result/);
  });
});
