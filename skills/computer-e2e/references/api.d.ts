// GENERATED from packages/computer-runtime/src/types.ts and
// packages/functions-computer-e2e/src/{types,context}.ts — do not edit.
// Regenerate with: bun scripts/generate-computer-e2e-api.ts
// The type reference for .e2e.ts suites (apiVersion 1). TypeScript is
// transpile-only at runtime; these declarations are editor support.
// shared desktop surface ------------------------------------------------
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

// suite contract ---------------------------------------------------------
export type CaseStatus = "passed" | "failed" | "skipped" | "not_run" | "interrupted";
export interface CaseContext {
  computer: Computer;
  signal: AbortSignal;
  params: Readonly<Record<string, string>>;
  artifactsDir: string;
  step<T>(name: string, work: () => Promise<T>): Promise<T>;
  skip(reason: string): never;
  setApplication(info: ApplicationInfo): void;
  capture(target: Target, name: string): Promise<{ elementsPath: string; screenshotPath?: string }>;
}
export interface TestCase {
  id: string;
  name: string;
  timeoutMs?: number;
  skip?: string;
  run(context: CaseContext): Promise<void> | void;
}
export interface Suite {
  apiVersion: 1;
  id: string;
  name: string;
  hookTimeoutMs?: number;
  beforeAll?(context: CaseContext): Promise<void> | void;
  afterAll?(context: CaseContext): Promise<void> | void;
  tests: TestCase[];
}
export interface ApplicationInfo {
  name: string;
  revision: string | null;
  dirty: boolean | null;
  environment: string;
}
