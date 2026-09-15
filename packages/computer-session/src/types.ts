// Session and wire types (B1). Business operation types come from
// computer-runtime via workspace import — never duplicated here. The wire
// carries windowId as a decimal STRING (JSON has no bigint); the codec in
// protocol.ts is the single conversion point.

import type { BatchRequest, ObserveOptions } from "@ya-skills/computer-runtime";

export type SessionState =
  | "starting"
  | "idle"
  | "running"
  | "stopping"
  | "closed"
  | "unusable";

export interface SessionInfo {
  id: string;
  target: { pid: number; windowId: string };
  state: SessionState;
  activeRequestId?: string;
  hostPid: number;
  generation: string;
  idleTimeoutMs: number;
}

export type SessionOperation =
  | { kind: "observe"; options?: ObserveOptions }
  | { kind: "batch"; request: BatchRequest }
  | { kind: "exec"; code: string; sourceName: string; timeoutMs: number; maxActions: number };

export interface SessionRequest {
  schemaVersion: 1;
  sessionId: string;
  generation: string;
  requestId: string;
  operation: SessionOperation;
}

export type SessionReplyStatus = "completed" | "failed" | "interrupted" | "running" | "unknown";

export interface SessionReply {
  schemaVersion: 1;
  requestId: string;
  status: SessionReplyStatus;
  result?: unknown;
  error?: { code: string; message: string };
}

// The control plane is deliberately separate from SessionRequest: it must
// stay answerable while a business operation is running.
export type SessionControl =
  | { kind: "status"; schemaVersion: 1; sessionId: string }
  | { kind: "cancel"; schemaVersion: 1; sessionId: string; requestId: string }
  | { kind: "close"; schemaVersion: 1; sessionId: string };

export interface SessionControlReply {
  schemaVersion: 1;
  info?: SessionInfo;
  error?: { code: string; message: string };
}
