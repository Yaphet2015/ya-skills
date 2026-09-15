// Script computer (C1): the in-worker facade. Every method is a fixed-name
// RPC to the host; no functions, selectors-as-lambdas, or arbitrary code
// cross the boundary. Receipts are HOST-generated — the script cannot
// self-report success.

import type { BatchRequest, Condition, ObserveOptions, PointClick, ScrollSpec, Selector } from "@ya-skills/computer-runtime";
import { decodeBatchResultValue, decodeObservationValue } from "./protocol.js";
import type { JsonValue, ScriptComputer, ScriptRpcMethod } from "./exec-types.js";

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
    async observe(options?: ObserveOptions) {
      const result = await send("observe", { ...(options !== undefined ? { options: options as unknown as JsonValue } : {}) });
      return decodeObservationValue(result);
    },
    async batch(request: BatchRequest) {
      const result = await send("batch", { request: request as unknown as JsonValue });
      return decodeBatchResultValue(result);
    }
  };
}
