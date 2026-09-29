// GENERATED from packages/computer-runtime/src/types.ts and
// packages/computer-session/src/exec-types.ts — do not edit.
// Regenerate with: bun scripts/generate-computer-use-api.ts
// The type reference for computer-use exec scripts (async-function body).
// shared desktop surface ------------------------------------------------
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Point {
  x: number;
  y: number;
}
export type ScrollDirection = "up" | "down" | "left" | "right";
export interface Selector {
  text: string;
  match: "exact" | "contains";
  role?: string;
}
export type Condition =
  | { kind: "element_exists"; selector: Selector }
  | { kind: "element_value"; selector: Selector; value: string }
  | { kind: "window_exists" }
  | { kind: "focused_element"; selector: Selector };
export interface PointClick {
  observationId: string;
  x: number;
  y: number;
}
export interface ScrollSpec {
  direction: ScrollDirection;
  amount: number;
  x: number;
  y: number;
}
export interface ObserveOptions {
  mode?: ObservationMode;
  maxDimension?: number;
  selector?: Selector;
}
export interface Observation {
  id: string;
  target: Target;
  capturedAt: number;
  /** Changes with every driver lifecycle. */
  epoch: string;
  /** Increments on every local mutation start. */
  revision: number;
  title: string;
  ax: AxChannel;
  image: ImageChannel;
}
export interface ImageGeometry {
  sourceWidth: number;
  sourceHeight: number;
  sentWidth: number;
  sentHeight: number;
  inputBounds: Rect;
  windowBounds: Rect;
}
export interface AxChannel {
  status: ChannelStatus;
  reason?: string;
  elements: AxElement[];
  total: number;
  returned: number;
  complete: boolean;
}
export interface ImageChannel {
  status: ChannelStatus;
  reason?: string;
  originalPath?: string;
  path?: string;
  frameValid?: boolean;
  geometry?: ImageGeometry;
}
export interface AxElement {
  role?: string;
  label?: string;
  value?: string;
  elementToken?: string;
  frame?: { x: number; y: number; w: number; h: number };
  enabled?: boolean;
  selected?: boolean;
}
export interface AxValueResult {
  route: "accessibility";
  effect: "confirmed";
  delivery?: {
    mode?: "not_applicable" | "background" | "foreground" | "unknown";
    deliveredCount?: number | null;
  };
}
export interface ActionResult {
  route: "accessibility" | "synthetic_events" | "global_input" | "system_api" | "dom" | "trusted_input";
  effect: "confirmed" | "partial" | "unverifiable" | "suspected_noop" | "refused";
  delivery?: {
    mode: "background" | "foreground" | "not_applicable" | "unknown";
    deliveredCount?: number | null;
  };
  escalation?: {
    target: "pixel" | "foreground" | "page" | "session";
    reason: "route_unavailable" | "delivery_failed" | "effect_unconfirmed" | "suspected_noop" | "permission_required";
  };
  error?: { code: string };
}
export type InputAddress = { elementToken: string; point?: never } | { point: PointClick; elementToken?: never };
export type ChannelStatus = "usable" | "empty" | "degraded" | "truncated" | "unavailable";
export type ObservationMode = "auto" | "ax" | "image" | "both";
export type BatchAction =
  | { kind: "click"; selector: Selector }
  | { kind: "click_point"; point: PointClick }
  | { kind: "set_value"; elementToken: string; value: string }
  | { kind: "type"; text: string; before?: Condition; input?: InputAddress }
  | { kind: "key"; key: string; modifiers?: string[]; before?: Condition; input?: InputAddress }
  | { kind: "scroll"; spec: ScrollSpec }
  | { kind: "wait"; condition: Condition; timeoutMs: number };
export interface BatchRequest {
  actions: BatchAction[];
  observe?: ObserveOptions;
  timeoutMs?: number;
  maxActions?: number;
}
export interface BatchResult {
  status: "completed" | "interrupted" | "failed";
  steps: ActionReceipt[];
  observation?: Observation;
  observationError?: { code: string; message: string };
}
export interface ActionReceipt {
  index: number;
  kind: BatchAction["kind"];
  status: "delivered" | "not_delivered" | "unknown" | "satisfied" | "not_run";
  error?: { code: string; message: string };
  result?: ActionResult;
}
export interface Target {
  pid: number;
  windowId: bigint;
}

// exec script surface ---------------------------------------------------
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface ScriptComputer {
  click(selector: Selector): Promise<ActionResult | void>;
  clickPoint(point: PointClick): Promise<ActionResult | void>;
  setValue(elementToken: string, value: string): Promise<AxValueResult>;
  type(text: string, before?: Condition, input?: InputAddress): Promise<ActionResult | void>;
  key(key: string, modifiers?: string[], before?: Condition, input?: InputAddress): Promise<ActionResult | void>;
  scroll(spec: ScrollSpec): Promise<ActionResult | void>;
  wait(condition: Condition, timeoutMs: number): Promise<void>;
  observe(options?: ObserveOptions): Promise<Observation>;
  batch(request: BatchRequest): Promise<BatchResult>;
}
export interface ExecResult {
  status: "completed" | "failed" | "interrupted" | "unknown";
  value?: JsonValue;
  stateVersion: number;
  stateCommitted: boolean;
  /** SHA-256 of the committed JSON state, when a commit occurred. */
  stateHash?: string;
  actions: ActionReceipt[];
  observations: Observation[];
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
