export interface BrowserTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export interface BrowserCdpError extends Error {
  code: string;
}

export interface CdpWebSocketLike {
  readyState?: number;
  addEventListener?(event: string, listener: (value: any) => void): void;
  removeEventListener?(event: string, listener: (value: any) => void): void;
  send(data: string): void;
  close(): void;
  [key: string]: any;
}

export interface ListTargetsOptions {
  endpoint?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  fetchImpl?: typeof fetch;
}

export interface EvaluateTargetOptions extends ListTargetsOptions {
  targetId: string;
  expression: string;
  webSocketFactory?: new (url: string) => CdpWebSocketLike;
}

export const DEFAULT_ENDPOINT: string;
export const DEFAULT_TIMEOUT_MS: number;
export const MAX_TIMEOUT_MS: number;
export const DEFAULT_MAX_OUTPUT_BYTES: number;
export const MAX_OUTPUT_BYTES: number;
export const MAX_EXPRESSION_BYTES: number;
export const BrowserCdpError: {
  new (code: string, message: string, cause?: unknown): BrowserCdpError;
  prototype: BrowserCdpError;
};
export function listTargets(options?: ListTargetsOptions): Promise<BrowserTarget[]>;
export function evaluateTarget(options: EvaluateTargetOptions): Promise<{
  target: BrowserTarget;
  result: unknown;
}>;
