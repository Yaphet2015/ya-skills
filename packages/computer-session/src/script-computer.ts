// Script computer (C1): the in-worker facade. Every method is a fixed-name
// RPC to the host; no functions, selectors-as-lambdas, or arbitrary code
// cross the boundary. Receipts are HOST-generated — the script cannot
// self-report success.

import type { BatchRequest, BatchResult, Condition, Observation, ObserveOptions, PointClick, ScrollSpec, Selector } from "@ya-skills/computer-runtime";
import type { JsonValue, ScriptComputer, ScriptRpcMethod } from "./exec-types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeObservation(value: unknown): Observation {
  if (!isRecord(value) || !isRecord(value.target) || typeof value.target.pid !== "number" || typeof value.target.windowId !== "bigint" ||
    !isRecord(value.ax) || !isRecord(value.image)) {
    throw new Error("host returned an invalid observation result");
  }
  return value as unknown as Observation;
}

function decodeBatch(value: unknown): BatchResult {
  if (!isRecord(value) || (value.status !== "completed" && value.status !== "interrupted" && value.status !== "failed") || !Array.isArray(value.steps)) {
    throw new Error("host returned an invalid batch result");
  }
  return value as unknown as BatchResult;
}

export function createScriptComputer(
  send: (method: ScriptRpcMethod, args: Record<string, JsonValue>) => Promise<JsonValue>
): ScriptComputer {
  return {
    async click(selector: Selector): Promise<void> {
      await send("click", { selector: selector as unknown as JsonValue });
    },
    async clickPoint(point: PointClick): Promise<void> {
      await send("click_point", { point: point as unknown as JsonValue });
    },
    async type(text: string, before?: Condition): Promise<void> {
      await send("type", { text, ...(before !== undefined ? { before: before as unknown as JsonValue } : {}) });
    },
    async key(key: string, modifiers?: string[], before?: Condition): Promise<void> {
      await send("key", {
        key,
        ...(modifiers !== undefined ? { modifiers } : {}),
        ...(before !== undefined ? { before: before as unknown as JsonValue } : {})
      });
    },
    async scroll(spec: ScrollSpec): Promise<void> {
      await send("scroll", { spec: spec as unknown as JsonValue });
    },
    async wait(condition: Condition, timeoutMs: number): Promise<void> {
      await send("wait", { condition: condition as unknown as JsonValue, timeoutMs });
    },
    async observe(options?: ObserveOptions): Promise<Observation> {
      const result = await send("observe", { ...(options !== undefined ? { options: options as unknown as JsonValue } : {}) });
      return decodeObservation(result);
    },
    async batch(request: BatchRequest): Promise<BatchResult> {
      const result = await send("batch", { request: request as unknown as JsonValue });
      return decodeBatch(result);
    }
  };
}
