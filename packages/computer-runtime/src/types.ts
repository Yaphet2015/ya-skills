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

// The driver-shaped seam the session facade sits on. `clickToken` takes a
// snapshot-scoped element token; predicate selection lives in actions.ts so
// the exactly-one rule is shared by every consumer.
export interface Backend {
  apps(): Promise<AppRef[]>;
  windows(pid: number, onScreenOnly?: boolean): Promise<WindowRef[]>;
  snapshot(target: Target, screenshot: boolean): Promise<Snapshot>;
  clickToken(target: Target, token: string): Promise<ToolResultLike>;
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
