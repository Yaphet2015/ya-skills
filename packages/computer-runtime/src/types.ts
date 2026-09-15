// Application-agnostic surface shared by the computer-use CLI and the e2e
// worker. No Cowork names, no CLI flags, no Skill concepts live here.

export interface Target {
  pid: number;
  windowId: bigint;
}

export interface WindowRef extends Target {
  title: string;
}

export interface AppRef {
  pid: number;
  name: string;
  bundleId?: string;
  running?: boolean;
  active?: boolean;
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

export interface Snapshot {
  elements: AxElement[];
  title: string;
  imageBase64?: string;
}

export type Predicate = (element: AxElement) => boolean;

export type ScrollDirection = "up" | "down" | "left" | "right";

export interface ScrollSpec {
  direction: ScrollDirection;
  amount: number;
  x: number;
  y: number;
}

export interface Computer {
  apps(): Promise<AppRef[]>;
  windows(pid: number, options?: { onScreenOnly?: boolean }): Promise<WindowRef[]>;
  snapshot(target: Target, options?: { screenshot?: boolean }): Promise<Snapshot>;
  observe(target: Target, options?: ObserveOptions): Promise<Observation>;
  clickPoint(target: Target, point: PointClick): Promise<void>;
  /** Execute one serial batch; an optional signal closes admission between
   * actions without pretending an in-flight native input was undone. */
  batch(target: Target, request: BatchRequest, signal?: AbortSignal): Promise<BatchResult>;
  click(target: Target, predicate: Predicate, description: string): Promise<void>;
  type(target: Target, text: string): Promise<void>;
  key(target: Target, key: string, modifiers?: string[]): Promise<void>;
  scroll(target: Target, options: ScrollSpec): Promise<void>;
  waitFor(
    target: Target,
    predicate: (elements: AxElement[]) => boolean,
    description: string,
    options?: { timeoutMs?: number; intervalMs?: number }
  ): Promise<AxElement[]>;
}

// Cua ToolResult shape (isError/text) as returned by the driver.
export interface ToolResultLike {
  isError?: boolean;
  text?: string;
}

// ---------------------------------------------------------------------------
// Agentic observation surfaces (desktop plan A2–A5). Channel validity is
// independent: usable AX never implies a usable image and vice versa.

export type ObservationMode = "auto" | "ax" | "image" | "both";

export type ChannelStatus = "usable" | "empty" | "degraded" | "truncated" | "unavailable";

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

/** Image geometry, in the units verified by the A1 probe: source/sent sizes
 * are screenshot PIXELS; inputBounds and windowBounds are screen-global
 * POINTS (window-local origin at inputBounds.x/y minus windowBounds.x/y). */
export interface ImageGeometry {
  sourceWidth: number;
  sourceHeight: number;
  sentWidth: number;
  sentHeight: number;
  inputBounds: Rect;
  windowBounds: Rect;
}

export interface Selector {
  text: string;
  match: "exact" | "contains";
  role?: string;
}

export interface ObserveOptions {
  mode?: ObservationMode;
  maxDimension?: number;
  selector?: Selector;
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

export interface PointClick {
  observationId: string;
  x: number;
  y: number;
}

export type Condition =
  | { kind: "element_exists"; selector: Selector }
  | { kind: "element_value"; selector: Selector; value: string }
  | { kind: "window_exists" }
  | { kind: "focused_element"; selector: Selector };

export type BatchAction =
  | { kind: "click"; selector: Selector }
  | { kind: "click_point"; point: PointClick }
  | { kind: "type"; text: string; before?: Condition }
  | { kind: "key"; key: string; modifiers?: string[]; before?: Condition }
  | { kind: "scroll"; spec: ScrollSpec }
  | { kind: "wait"; condition: Condition; timeoutMs: number };

export interface BatchRequest {
  actions: BatchAction[];
  observe?: ObserveOptions;
  timeoutMs?: number;
  maxActions?: number;
}

export interface ActionReceipt {
  index: number;
  kind: BatchAction["kind"];
  status: "delivered" | "not_delivered" | "unknown" | "satisfied" | "not_run";
  error?: { code: string; message: string };
}

export interface BatchResult {
  status: "completed" | "interrupted" | "failed";
  steps: ActionReceipt[];
  observation?: Observation;
  observationError?: { code: string; message: string };
}


// The driver-shaped seam the session facade sits on. `clickToken` takes a
// snapshot-scoped element token; predicate selection lives in actions.ts so
// the exactly-one rule is shared by every consumer.
export interface Backend {
  apps(): Promise<AppRef[]>;
  windows(pid: number, onScreenOnly?: boolean): Promise<WindowRef[]>;
  snapshot(target: Target, screenshot: boolean): Promise<Snapshot>;
  /** Raw single-read observation. `screenshot` requests the image channel;
   * the returned state carries whatever channels the driver produced. */
  observe(target: Target, options: { accessibility: boolean; screenshot: boolean; maxDimension?: number }): Promise<NativeObservationLike>;
  clickToken(target: Target, token: string): Promise<ToolResultLike>;
  clickPoint(target: Target, point: Point): Promise<ToolResultLike>;
  type(target: Target, text: string): Promise<ToolResultLike>;
  key(target: Target, key: string, modifiers?: string[]): Promise<ToolResultLike>;
  scroll(target: Target, options: ScrollSpec): Promise<ToolResultLike>;
  metadata(): Promise<{ driverVersion?: string; pid?: number }>;
  permissions(): Promise<{ accessibility: boolean; screenRecording: boolean }>;
  endSession(): Promise<void>;
  shutdown(): Promise<void>;
  destroy(): void;
}

export interface BackendFactory {
  load(): Promise<unknown>;
  create(sdk: unknown): Promise<Backend>;
}

/** Structural mirror of the SDK WindowStateOutput plus session-injected
 * identity metadata. Type-only shape: nothing here loads the native SDK, and
 * fakes construct it freely. The real adapter produces SDK-typed values that
 * structurally satisfy this interface (see cua-backend.ts). */
export interface NativeObservationLike {
  pid: number;
  windowId: bigint;
  snapshotId?: string;
  appName?: string;
  windowTitle?: string;
  elements?: unknown;
  totalElementCount?: bigint;
  returnedElementCount?: bigint;
  filteredElementCount?: bigint;
  elementsComplete?: boolean;
  degraded?: boolean;
  degradedReason?: string;
  truncated?: boolean;
  truncationReason?: string;
  screenshotWidth?: number;
  screenshotHeight?: number;
  screenshotScale?: number;
  screenshotMimeType?: string;
  screenshotFilePath?: string;
  screenshotFrameValid?: boolean;
  windowBounds?: { x: number; y: number; width: number; height: number };
  images?: Array<{ mimeType?: string; dataBase64?: string }>;
  // session-injected metadata (never backend-generated):
  observationId: string;
  capturedAt: number;
  epoch: string;
  revision: number;
}
