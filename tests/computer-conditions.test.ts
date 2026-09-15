import { describe, expect, test } from "bun:test";
import { evaluateCondition, UnsupportedConditionError } from "../packages/computer-runtime/src/conditions.js";
import type { NativeObservationLike, Observation } from "../packages/computer-runtime/src/types.js";
import { makeNativeObservation, type NativeObservationOverrides } from "./helpers/computer-fixtures.js";
import { projectObservation } from "../packages/computer-runtime/src/observe.js";

function observation(elements: Array<Record<string, unknown>>, overrides: NativeObservationOverrides = {}): Observation {
  const raw: NativeObservationLike = makeNativeObservation({
    elements,
    totalElementCount: BigInt(elements.length),
    returnedElementCount: BigInt(elements.length),
    ...overrides
  });
  return projectObservation(raw, { mode: "ax" }, { accessibility: true, screenshot: false });
}

describe("evaluateCondition", () => {
  test("element_exists matches by exact label", () => {
    const view = observation([{ elementIndex: 0n, role: "AXButton", label: "Search", depth: 1 }]);
    expect(evaluateCondition({ kind: "element_exists", selector: { text: "Search", match: "exact" } }, view)).toBe(true);
    expect(evaluateCondition({ kind: "element_exists", selector: { text: "Se", match: "contains" } }, view)).toBe(true);
    expect(evaluateCondition({ kind: "element_exists", selector: { text: "Search", match: "exact", role: "AXCheckBox" } }, view)).toBe(false);
  });

  test("element_value requires exactly one match and the exact value", () => {
    const single = observation([{ elementIndex: 0n, role: "AXTextField", label: "Query", value: "penguin", depth: 1 }]);
    expect(evaluateCondition({ kind: "element_value", selector: { text: "Query", match: "exact" }, value: "penguin" }, single)).toBe(true);
    expect(evaluateCondition({ kind: "element_value", selector: { text: "Query", match: "exact" }, value: "penguins" }, single)).toBe(false);
    const duplicate = observation([
      { elementIndex: 0n, role: "AXTextField", label: "Query", value: "penguin", depth: 1 },
      { elementIndex: 1n, role: "AXTextField", label: "Query", value: "penguin", depth: 1 }
    ]);
    expect(evaluateCondition({ kind: "element_value", selector: { text: "Query", match: "exact" }, value: "penguin" }, duplicate)).toBe(false);
  });

  test("degraded or truncated AX never satisfies element conditions", () => {
    const degraded = observation([{ elementIndex: 0n, role: "AXButton", label: "Search", depth: 1 }], { degraded: true, degradedReason: "ax_partial" });
    expect(evaluateCondition({ kind: "element_exists", selector: { text: "Search", match: "exact" } }, degraded)).toBe(false);
  });

  test("window_exists is true when any channel answered", () => {
    const view = observation([]);
    expect(evaluateCondition({ kind: "window_exists" }, view)).toBe(true);
  });

  test("focused_element throws unsupported_condition — selected is not focus", () => {
    const view = observation([{ elementIndex: 0n, role: "AXCheckBox", label: "ToggleMe", selected: true, depth: 1 }]);
    expect(() =>
      evaluateCondition({ kind: "focused_element", selector: { text: "ToggleMe", match: "exact" } }, view)
    ).toThrow(UnsupportedConditionError);
  });
});
