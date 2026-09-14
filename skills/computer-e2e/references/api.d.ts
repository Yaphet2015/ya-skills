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
