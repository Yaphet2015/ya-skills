// Exec wire types (C1): the fixed RPC surface between the script worker and
// the host. Only these method names may cross the pipe; args are JSON.

import type {
  AxValueResult,
  Condition,
  ObserveOptions,
  ScrollSpec,
  Selector,
  PointClick
} from "@ya-skills/computer-runtime";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type ScriptRpcMethod =
  | "click"
  | "click_point"
  | "set_value"
  | "type"
  | "key"
  | "scroll"
  | "wait"
  | "observe"
  | "batch";

export interface ScriptRpcRequest {
  seq: number;
  method: ScriptRpcMethod;
  args: Record<string, JsonValue>;
}

export type ScriptRpcReply =
  | { seq: number; ok: true; result: JsonValue }
  | { seq: number; ok: false; error: { code: string; message: string } };

/** The desktop facade a script sees. Selector/condition validation happens in
 * the host through the runtime — lambdas never cross the wire. */
export interface ScriptComputer {
  click(selector: Selector): Promise<void>;
  clickPoint(point: PointClick): Promise<void>;
  setValue(elementToken: string, value: string): Promise<AxValueResult>;
  type(text: string, before?: Condition): Promise<void>;
  key(key: string, modifiers?: string[], before?: Condition): Promise<void>;
  scroll(spec: ScrollSpec): Promise<void>;
  wait(condition: Condition, timeoutMs: number): Promise<void>;
  observe(options?: ObserveOptions): Promise<import("@ya-skills/computer-runtime").Observation>;
  batch(request: import("@ya-skills/computer-runtime").BatchRequest): Promise<import("@ya-skills/computer-runtime").BatchResult>;
}

export interface ExecResult {
  status: "completed" | "failed" | "interrupted" | "unknown";
  value?: JsonValue;
  stateVersion: number;
  stateCommitted: boolean;
  /** SHA-256 of the committed JSON state, when a commit occurred. */
  stateHash?: string;
  actions: import("@ya-skills/computer-runtime").ActionReceipt[];
  observations: import("@ya-skills/computer-runtime").Observation[];
  /** Number of observations omitted from a bounded terminal receipt. */
  observationsDropped?: number;
  logs: string[];
  error?: { code: string; message: string };
}

export interface ExecOptions {
  code: string;
  sourceName: string;
  timeoutMs: number;
  maxActions: number;
}

export const EXEC_DEFAULT_TIMEOUT_MS = 60_000;
export const EXEC_MAX_TIMEOUT_MS = 120_000;
export const EXEC_DEFAULT_MAX_ACTIONS = 100;
export const EXEC_MAX_ACTIONS_LIMIT = 500;
export const EXEC_MAX_CODE_BYTES = 256 * 1024;
export const EXEC_MAX_STATE_BYTES = 256 * 1024;
export const EXEC_MAX_LOG_BYTES = 64 * 1024;
export const EXEC_MAX_OBSERVATIONS = 20;

export const SCRIPT_METHODS: readonly ScriptRpcMethod[] = [
  "click",
  "click_point",
  "set_value",
  "type",
  "key",
  "scroll",
  "wait",
  "observe",
  "batch"
];
