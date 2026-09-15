// NDJSON framing (B1): newline-delimited JSON, 1 MiB per message, hard
// version check, and the ONLY bigint<->decimal-string windowId codec. A frame
// larger than the limit aborts the connection immediately — the buffer never
// accumulates an oversized message before validating.

import type { SessionOperation, SessionReply, SessionRequest } from "./types.js";

export const MAX_MESSAGE_BYTES = 1024 * 1024;
export const PROTOCOL_VERSION = 1;

function convertWindowId(value: unknown, where: string): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    if (!/^\d+$/.test(value)) {
      throw new ProtocolError("protocol_window_id", `${where} must be decimal digits (got: ${value})`);
    }
    return BigInt(value);
  }
  return value;
}

function deepConvertWindowIds(value: unknown, where: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item, i) => deepConvertWindowIds(item, `${where}[${i}]`));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === "windowId") {
        out[key] = convertWindowId(entry, `${where}.${key}`);
      } else {
        out[key] = deepConvertWindowIds(entry, `${where}.${key}`);
      }
    }
    return out;
  }
  return value;
}

export class ProtocolError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    // The code leads the message so string-matching callers (and tests) can
    // classify without catching the class.
    super(`${code}: ${message}`);
  }
}

/** Deep-restore bigint windowIds from their wire form (decimal strings) —
 * the single conversion point for BOTH requests and decoded results
 * (observations carry target ids; review P2.7). */
export function deepRestoreWindowIds(value: unknown): unknown {
  return deepConvertWindowIds(value, "result");
}

function encodeLine(value: unknown): string {
  const text = JSON.stringify(value, (_key, entry) =>
    typeof entry === "bigint" ? entry.toString() : entry
  );
  if (text === undefined) {
    throw new ProtocolError("protocol_encode", "message is not JSON-serializable");
  }
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_MESSAGE_BYTES) {
    throw new ProtocolError("protocol_message_too_large", `message is ${bytes} bytes (limit ${MAX_MESSAGE_BYTES})`);
  }
  if (text.includes("\n")) {
    throw new ProtocolError("protocol_encode", "message contains a raw newline");
  }
  return `${text}\n`;
}

export function encodeRequest(request: SessionRequest): string {
  return encodeLine(request);
}

export function decodeRequest(line: string): SessionRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new ProtocolError("protocol_json", "request line is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new ProtocolError("protocol_json", "request must be an object");
  }
  const request = parsed as Record<string, unknown>;
  if (request.schemaVersion !== PROTOCOL_VERSION) {
    throw new ProtocolError(
      "protocol_version",
      `schemaVersion must be ${PROTOCOL_VERSION} (got: ${String(request.schemaVersion)})`
    );
  }
  if (typeof request.sessionId !== "string" || request.sessionId.length === 0) {
    throw new ProtocolError("protocol_session", "sessionId must be a non-empty string");
  }
  if (typeof request.generation !== "string" || request.generation.length === 0) {
    throw new ProtocolError("protocol_generation", "generation must be a non-empty string");
  }
  if (typeof request.requestId !== "string" || request.requestId.length === 0) {
    throw new ProtocolError("protocol_request_id", "requestId must be a non-empty string");
  }
  const operation = request.operation;
  if (typeof operation !== "object" || operation === null) {
    throw new ProtocolError("protocol_operation", "operation must be an object");
  }
  const kind = (operation as Record<string, unknown>).kind;
  if (kind !== "observe" && kind !== "batch" && kind !== "exec") {
    throw new ProtocolError("protocol_operation", `operation.kind must be observe|batch|exec (got: ${String(kind)})`);
  }
  // windowId arrives as a decimal string everywhere; convert once, here.
  return deepConvertWindowIds(request, "request") as unknown as SessionRequest;
}

/** Incremental NDJSON frame reader with the size cap enforced per frame.
 * Decoding is STREAMING UTF-8 (F17): a multibyte sequence split across chunk
 * boundaries survives intact instead of collapsing to replacement
 * characters. Malformed UTF-8 aborts the connection explicitly. */
export class FrameReader {
  private decoder = new TextDecoder("utf-8", { fatal: true });
  private buffer = "";
  /** Bytes in the current unterminated frame only. Several valid frames may
   * arrive in one socket chunk, so a chunk-wide counter is incorrect. */
  private frameBytes = 0;
  private exceeded = false;

  push(chunk: Buffer | Uint8Array | string): string[] {
    if (this.exceeded) return [];
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    // Scan bytes before accumulating decoded text. Newline is ASCII and can
    // never occur inside a multibyte sequence; this enforces each frame's
    // limit even when many frames share one chunk.
    for (const byte of bytes) {
      if (byte === 0x0a) {
        this.frameBytes = 0;
      } else {
        this.frameBytes++;
        if (this.frameBytes > MAX_MESSAGE_BYTES) {
          this.exceeded = true;
          this.buffer = "";
          throw new ProtocolError("protocol_message_too_large", `frame exceeds ${MAX_MESSAGE_BYTES} bytes`);
        }
      }
    }
    let text: string;
    try {
      text = typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    } catch {
      this.exceeded = true;
      throw new ProtocolError("protocol_utf8", "frame data is not valid UTF-8");
    }
    this.buffer += text;
    const frames: string[] = [];
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) break;
      frames.push(this.buffer.slice(0, newline));
      this.buffer = this.buffer.slice(newline + 1);
    }
    return frames;
  }
}

export function encodeControl(value: unknown): string {
  return encodeLine(value);
}

export function decodeReply(line: string): {
  schemaVersion: number;
  requestId?: string;
  status?: string;
  error?: { code: string; message: string };
  info?: unknown;
  result?: unknown;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new ProtocolError("protocol_json", "reply line is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new ProtocolError("protocol_json", "reply must be an object");
  }
  const reply = parsed as Record<string, unknown>;
  if (reply.schemaVersion !== PROTOCOL_VERSION) {
    throw new ProtocolError(
      "protocol_version",
      `schemaVersion must be ${PROTOCOL_VERSION} (got: ${String(reply.schemaVersion)})`
    );
  }
  return parsed as ReturnType<typeof decodeReply>;
}

const REPLY_STATUSES = new Set(["completed", "failed", "interrupted", "running", "unknown"]);
const RECEIPT_STATUSES = new Set(["delivered", "not_delivered", "unknown", "satisfied", "not_run"]);

/** Decode a business reply with the operation-specific shape checks that the
 * wire contract promises. It deliberately does not accept arbitrary result
 * JSON: callers receive a typed observation/batch/exec-shaped object, and
 * decimal window ids are restored at this single boundary. */
export function decodeSessionReply(line: string, operation: SessionOperation): SessionReply {
  const raw = decodeReply(line);
  if (typeof raw.requestId !== "string" || raw.requestId.length === 0) {
    throw new ProtocolError("protocol_request_id", "business reply is missing requestId");
  }
  if (typeof raw.status !== "string" || !REPLY_STATUSES.has(raw.status)) {
    throw new ProtocolError("protocol_status", `business reply status is invalid: ${String(raw.status)}`);
  }
  if (raw.error !== undefined) {
    if (typeof raw.error !== "object" || raw.error === null ||
      typeof (raw.error as { code?: unknown }).code !== "string" ||
      typeof (raw.error as { message?: unknown }).message !== "string") {
      throw new ProtocolError("protocol_error", "business reply error must contain string code/message");
    }
  }
  if (raw.result === undefined) {
    if (raw.status === "completed") {
      throw new ProtocolError("protocol_result", `completed ${operation.kind} reply is missing result`);
    }
    return raw as unknown as SessionReply;
  }
  const result = deepRestoreWindowIds(raw.result);
  if (operation.kind === "observe") {
    if (!isRecord(result) || !isRecord(result.target) || typeof result.target.pid !== "number" || typeof result.target.windowId !== "bigint") {
      throw new ProtocolError("protocol_result", "observe result has an invalid target");
    }
  } else if (operation.kind === "batch") {
    if (!isRecord(result) || (result.status !== "completed" && result.status !== "interrupted" && result.status !== "failed") || !Array.isArray(result.steps)) {
      throw new ProtocolError("protocol_result", "batch result must contain status and steps");
    }
    for (const step of result.steps) {
      if (!isRecord(step) || !RECEIPT_STATUSES.has(String(step.status))) {
        throw new ProtocolError("protocol_result", "batch result contains an invalid action receipt");
      }
    }
  } else if (operation.kind === "exec") {
    if (!isRecord(result) || (result.status !== "completed" && result.status !== "failed" && result.status !== "interrupted" && result.status !== "unknown") || !Array.isArray(result.actions) || !Array.isArray(result.observations)) {
      throw new ProtocolError("protocol_result", "exec result must contain status/actions/observations");
    }
  }
  return { ...(raw as unknown as SessionReply), result };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
