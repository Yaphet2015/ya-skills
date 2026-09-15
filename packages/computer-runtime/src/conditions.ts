// Restricted structured wait conditions (A5). Only enumerable predicate
// kinds; no arbitrary JS ever crosses the batch boundary. focused_element
// stays unsupported until the SDK exposes a real focus state (A1: no
// `focused` field exists — selected is not focus).

import type { Condition, Observation, Selector } from "./types.js";
import { selectorMatches } from "./observe.js";

export class UnsupportedConditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedConditionError";
  }
}

function axUsableForConditions(observation: Observation): boolean {
  // A partial (incomplete) or filtered tree can never PROVE an existence or
  // value condition: only a complete, usable AX view may satisfy one.
  return observation.ax.status === "usable" && observation.ax.complete === true;
}

/** Evaluate a condition against one observation. Throws
 * UnsupportedConditionError for kinds the platform cannot verify. */
export function evaluateCondition(condition: Condition, observation: Observation): boolean {
  switch (condition.kind) {
    case "element_exists": {
      if (!axUsableForConditions(observation)) return false;
      const matches = observation.ax.elements.filter((e) => selectorMatches(condition.selector as Selector, e));
      // A condition is useful for deterministic local gating only when the
      // selector identifies one element; ambiguity must return to the caller
      // rather than silently choosing one.
      return matches.length === 1;
    }
    case "element_value": {
      if (!axUsableForConditions(observation)) return false;
      const matches = observation.ax.elements.filter((e) => selectorMatches(condition.selector, e));
      if (matches.length !== 1) return false;
      return matches[0]!.value === condition.value;
    }
    case "window_exists": {
      return observation.ax.status !== "unavailable" || observation.image.status !== "unavailable";
    }
    case "focused_element": {
      // The SDK exposes no focus state (A1 static + native conclusion).
      // selected is not focused; a click in the past is not focus either.
      throw new UnsupportedConditionError(
        "focused_element is unsupported: the driver exposes no verifiable focus state — re-observe and decide from the next frame instead"
      );
    }
    default:
      throw new UnsupportedConditionError(`unknown condition kind: ${(condition as Condition).kind}`);
  }
}

export function isUnsupportedCondition(error: unknown): boolean {
  return error instanceof UnsupportedConditionError;
}
