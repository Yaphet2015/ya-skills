// NDJSON framing and schema-aware session wire codecs (B1/F13).
//
// The transport is deliberately smaller than the desktop domain: JSON carries
// window ids as decimal strings, while runtime Target values use bigint.  The
// conversion is performed only at declared Target locations.  In particular,
// an exec script's arbitrary JSON return value is not traversed for properties
// named `windowId`.

import {
  DEFAULT_MAX_ACTIONS,
  MAX_ACTIONS_LIMIT,
  MAX_BATCH_TIMEOUT_MS
} from "@ya-skills/computer-runtime";
import type {
  ActionReceipt,
  AxChannel,
  AxElement,
  AxValueResult,
  BatchAction,
  BatchRequest,
  BatchResult,
  Condition,
  ImageChannel,
  ImageGeometry,
  Observation,
  ObserveOptions,
  PointClick,
  Rect,
  ScrollSpec,
  Selector,
  Target
} from "@ya-skills/computer-runtime";
import type {
  SessionControlReply,
  SessionInfo,
  SessionOperation,
  SessionReply,
  SessionRequest
} from "./types.js";
import {
  EXEC_MAX_ACTIONS_LIMIT,
  EXEC_MAX_LOG_BYTES,
  EXEC_MAX_STATE_BYTES,
  EXEC_MAX_OBSERVATIONS,
  EXEC_MAX_TIMEOUT_MS,
  type ExecResult,
  type JsonValue
} from "./exec-types.js";
import { JsonValueValidationError, validateJsonValue } from "./json-value.js";

export const MAX_MESSAGE_BYTES = 1024 * 1024;
export const PROTOCOL_VERSION = 1;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ID_BYTES = 256;
const MAX_FIELD_BYTES = 256 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const MAX_AX_ELEMENTS = 10_000;
const MAX_RECEIPTS = EXEC_MAX_ACTIONS_LIMIT;
const MAX_MODIFIERS = 64;

const OBSERVATION_MODES = ["auto", "ax", "image", "both"] as const;
const CHANNEL_STATUSES = ["usable", "empty", "degraded", "truncated", "unavailable"] as const;
const ACTION_KINDS = ["click", "click_point", "set_value", "type", "key", "scroll", "wait"] as const;
const RECEIPT_STATUSES = ["delivered", "not_delivered", "unknown", "satisfied", "not_run"] as const;
const REPLY_STATUSES = ["completed", "failed", "interrupted", "running", "unknown"] as const;
const EXEC_STATUSES = ["completed", "failed", "interrupted", "unknown"] as const;
const SESSION_STATES = ["starting", "idle", "running", "stopping", "closed", "unusable"] as const;
const SCROLL_DIRECTIONS = ["up", "down", "left", "right"] as const;
const CONDITION_KINDS = ["element_exists", "element_value", "window_exists", "focused_element"] as const;
export class ProtocolError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    // Put the stable code first so callers can classify protocol failures
    // without depending on a particular nested-field wording.
    super(`${code}: ${message}`);
    this.name = "ProtocolError";
  }
}

type ValidationContext = "protocol_request" | "protocol_operation" | "protocol_result" | "protocol_control" | "protocol_rpc";
type WindowIdEncoding = "wire" | "native";

type KnownReply = {
  schemaVersion: number;
  requestId?: string;
  status?: string;
  error?: { code: string; message: string };
  info?: unknown;
  result?: unknown;
  [key: string]: unknown;
};

function fail(context: ValidationContext, where: string, message: string): never {
  throw new ProtocolError(context, `${where}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function requireRecord(value: unknown, context: ValidationContext, where: string): Record<string, unknown> {
  if (!isRecord(value)) fail(context, where, "must be an object");
  return value;
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  context: ValidationContext,
  where: string
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail(context, `${where}.${key}`, "is not part of this wire schema");
  }
}

/** Preserve optional metadata without allowing a source key such as
 * `__proto__` to mutate the receiver's prototype. Declared fields are written
 * by each parser after validation; this helper copies only non-schema keys. */
function copyUnknownFields<T extends object>(
  source: Record<string, unknown>,
  target: T,
  declared: readonly string[]
): T {
  const declaredSet = new Set(declared);
  for (const [key, value] of Object.entries(source)) {
    if (declaredSet.has(key)) continue;
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value
    });
  }
  return target;
}

function stringValue(
  value: unknown,
  context: ValidationContext,
  where: string,
  options: { nonEmpty?: boolean; maxBytes?: number } = {}
): string {
  if (typeof value !== "string") fail(context, where, "must be a string");
  const maxBytes = options.maxBytes ?? MAX_FIELD_BYTES;
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > maxBytes) fail(context, where, `exceeds ${maxBytes} UTF-8 bytes`);
  if (options.nonEmpty && value.length === 0) fail(context, where, "must not be empty");
  return value;
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  context: ValidationContext,
  where: string,
  options: { nonEmpty?: boolean; maxBytes?: number } = {}
): string {
  if (!hasOwn(value, key) || value[key] === undefined) fail(context, `${where}.${key}`, "is required");
  return stringValue(value[key], context, `${where}.${key}`, options);
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
  context: ValidationContext,
  where: string,
  options: { nonEmpty?: boolean; maxBytes?: number } = {}
): string | undefined {
  if (!hasOwn(value, key) || value[key] === undefined) return undefined;
  return stringValue(value[key], context, `${where}.${key}`, options);
}

function finiteNumber(
  value: unknown,
  context: ValidationContext,
  where: string,
  options: { integer?: boolean; min?: number; max?: number } = {}
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(context, where, "must be a finite number");
  }
  if (options.integer && !Number.isSafeInteger(value)) {
    fail(context, where, "must be a safe integer");
  }
  if (options.min !== undefined && value < options.min) {
    fail(context, where, `must be >= ${options.min}`);
  }
  if (options.max !== undefined && value > options.max) {
    fail(context, where, `must be <= ${options.max}`);
  }
  return value;
}

function enumValue<T extends string>(
  value: unknown,
  choices: readonly T[],
  context: ValidationContext,
  where: string
): T {
  if (typeof value !== "string" || !choices.includes(value as T)) {
    fail(context, where, `must be one of ${choices.join("|")}`);
  }
  return value as T;
}

function optionalBoolean(
  value: Record<string, unknown>,
  key: string,
  context: ValidationContext,
  where: string
): boolean | undefined {
  if (!hasOwn(value, key) || value[key] === undefined) return undefined;
  if (typeof value[key] !== "boolean") fail(context, `${where}.${key}`, "must be a boolean");
  return value[key] as boolean;
}

function requiredBoolean(value: Record<string, unknown>, key: string, context: ValidationContext, where: string): boolean {
  if (!hasOwn(value, key) || typeof value[key] !== "boolean") fail(context, `${where}.${key}`, "must be a boolean");
  return value[key] as boolean;
}

function nonNegativeInteger(value: unknown, context: ValidationContext, where: string, max?: number): number {
  return finiteNumber(value, context, where, { integer: true, min: 0, ...(max !== undefined ? { max } : {}) });
}

function positiveInteger(value: unknown, context: ValidationContext, where: string, max?: number): number {
  return finiteNumber(value, context, where, { integer: true, min: 1, ...(max !== undefined ? { max } : {}) });
}

function parseJsonLine(line: string, context: ValidationContext, noun: string): unknown {
  if (typeof line !== "string") fail(context, noun, "must be a string");
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes > MAX_MESSAGE_BYTES) {
    throw new ProtocolError("protocol_message_too_large", `${noun} is ${bytes} bytes (limit ${MAX_MESSAGE_BYTES})`);
  }
  try {
    return JSON.parse(line) as unknown;
  } catch {
    throw new ProtocolError("protocol_json", `${noun} is not valid JSON`);
  }
}

function parseWireWindowId(value: unknown, context: ValidationContext, where: string): string {
  const id = stringValue(value, context, where, { nonEmpty: true, maxBytes: 128 });
  if (!/^\d+$/.test(id)) fail(context, where, "must contain decimal digits only");
  // BigInt conversion is checked here without returning the bigint so the
  // control-plane SessionInfo contract can retain its string representation.
  try {
    BigInt(id);
  } catch {
    fail(context, where, "is not a valid decimal window id");
  }
  return id;
}

function parseNativeWindowId(value: unknown, context: ValidationContext, where: string): bigint {
  if (typeof value !== "bigint" || value < 0n) fail(context, where, "must be a non-negative bigint");
  return value;
}

function parsePid(value: unknown, context: ValidationContext, where: string): number {
  return positiveInteger(value, context, where);
}

function parseTarget(
  value: unknown,
  context: ValidationContext,
  where: string,
  encoding: WindowIdEncoding
): Target {
  const raw = requireRecord(value, context, where);
  const pid = parsePid(raw.pid, context, `${where}.pid`);
  const windowId = encoding === "wire"
    ? BigInt(parseWireWindowId(raw.windowId, context, `${where}.windowId`))
    : parseNativeWindowId(raw.windowId, context, `${where}.windowId`);
  // Declared fields have all been validated before metadata is copied;
  // unknown target metadata is retained without recursively rewriting ids.
  return copyUnknownFields(raw, { pid, windowId }, ["pid", "windowId"]);
}

function parseSessionTarget(value: unknown, context: ValidationContext, where: string): { pid: number; windowId: string } {
  const raw = requireRecord(value, context, where);
  const pid = parsePid(raw.pid, context, `${where}.pid`);
  const windowId = parseWireWindowId(raw.windowId, context, `${where}.windowId`);
  return copyUnknownFields(raw, { pid, windowId }, ["pid", "windowId"]);
}

function parseSelector(value: unknown, context: ValidationContext, where: string): Selector {
  const raw = requireRecord(value, context, where);
  assertKnownKeys(raw, ["text", "match", "role"], context, where);
  const text = requiredString(raw, "text", context, where, { nonEmpty: true, maxBytes: 10_000 });
  const match = enumValue(raw.match, ["exact", "contains"] as const, context, `${where}.match`);
  const role = optionalString(raw, "role", context, where, { nonEmpty: true, maxBytes: 10_000 });
  return role === undefined ? { text, match } : { text, match, role };
}

function parseObserveOptions(value: unknown, context: ValidationContext, where: string): ObserveOptions {
  const raw = requireRecord(value, context, where);
  assertKnownKeys(raw, ["mode", "maxDimension", "selector"], context, where);
  const mode = raw.mode === undefined
    ? undefined
    : enumValue(raw.mode, OBSERVATION_MODES, context, `${where}.mode`);
  const maxDimension = raw.maxDimension === undefined
    ? undefined
    : positiveInteger(raw.maxDimension, context, `${where}.maxDimension`, 8192);
  if (maxDimension !== undefined && maxDimension < 64) {
    fail(context, `${where}.maxDimension`, "must be >= 64");
  }
  const selector = raw.selector === undefined ? undefined : parseSelector(raw.selector, context, `${where}.selector`);
  return {
    ...(mode !== undefined ? { mode } : {}),
    ...(maxDimension !== undefined ? { maxDimension } : {}),
    ...(selector !== undefined ? { selector } : {})
  };
}

function parsePointClick(value: unknown, context: ValidationContext, where: string): PointClick {
  const raw = requireRecord(value, context, where);
  assertKnownKeys(raw, ["observationId", "x", "y"], context, where);
  const observationId = requiredString(raw, "observationId", context, where, { nonEmpty: true, maxBytes: MAX_ID_BYTES });
  if (!UUID_RE.test(observationId)) fail(context, `${where}.observationId`, "must be a UUID");
  const x = finiteNumber(raw.x, context, `${where}.x`, { min: 0 });
  const y = finiteNumber(raw.y, context, `${where}.y`, { min: 0 });
  return { observationId, x, y };
}

function parseCondition(value: unknown, context: ValidationContext, where: string): Condition {
  const raw = requireRecord(value, context, where);
  const kind = enumValue(raw.kind, CONDITION_KINDS, context, `${where}.kind`);
  switch (kind) {
    case "element_exists":
      assertKnownKeys(raw, ["kind", "selector"], context, where);
      return { kind, selector: parseSelector(raw.selector, context, `${where}.selector`) };
    case "element_value": {
      assertKnownKeys(raw, ["kind", "selector", "value"], context, where);
      const valueText = requiredString(raw, "value", context, where, { maxBytes: 10_000 });
      return { kind, selector: parseSelector(raw.selector, context, `${where}.selector`), value: valueText };
    }
    case "window_exists":
      assertKnownKeys(raw, ["kind"], context, where);
      return { kind };
    case "focused_element":
      assertKnownKeys(raw, ["kind", "selector"], context, where);
      return { kind, selector: parseSelector(raw.selector, context, `${where}.selector`) };
  }
}

function parseScrollSpec(value: unknown, context: ValidationContext, where: string): ScrollSpec {
  const raw = requireRecord(value, context, where);
  assertKnownKeys(raw, ["direction", "amount", "x", "y"], context, where);
  const direction = enumValue(raw.direction, SCROLL_DIRECTIONS, context, `${where}.direction`);
  const amount = positiveInteger(raw.amount, context, `${where}.amount`, 100);
  const x = finiteNumber(raw.x, context, `${where}.x`, { min: 0 });
  const y = finiteNumber(raw.y, context, `${where}.y`, { min: 0 });
  return { direction, amount, x, y };
}

function parseBatchAction(value: unknown, context: ValidationContext, index: number): BatchAction {
  const where = `actions[${index}]`;
  const raw = requireRecord(value, context, where);
  const kind = enumValue(raw.kind, ACTION_KINDS, context, `${where}.kind`);
  switch (kind) {
    case "click":
      assertKnownKeys(raw, ["kind", "selector"], context, where);
      return { kind, selector: parseSelector(raw.selector, context, `${where}.selector`) };
    case "click_point":
      assertKnownKeys(raw, ["kind", "point"], context, where);
      return { kind, point: parsePointClick(raw.point, context, `${where}.point`) };
    case "set_value": {
      assertKnownKeys(raw, ["kind", "elementToken", "value"], context, where);
      const elementToken = requiredString(raw, "elementToken", context, where, { nonEmpty: true, maxBytes: MAX_ID_BYTES });
      const value = requiredString(raw, "value", context, where, { maxBytes: MAX_FIELD_BYTES });
      return { kind, elementToken, value };
    }
    case "type": {
      assertKnownKeys(raw, ["kind", "text", "before"], context, where);
      const text = requiredString(raw, "text", context, where, { nonEmpty: true, maxBytes: 10_000 });
      const before = raw.before === undefined ? undefined : parseCondition(raw.before, context, `${where}.before`);
      return before === undefined ? { kind, text } : { kind, text, before };
    }
    case "key": {
      assertKnownKeys(raw, ["kind", "key", "modifiers", "before"], context, where);
      const key = requiredString(raw, "key", context, where, { nonEmpty: true, maxBytes: 64 });
      let modifiers: string[] | undefined;
      if (raw.modifiers !== undefined) {
        if (!Array.isArray(raw.modifiers)) fail(context, `${where}.modifiers`, "must be an array");
        if (raw.modifiers.length > MAX_MODIFIERS) fail(context, `${where}.modifiers`, `may contain at most ${MAX_MODIFIERS} entries`);
        modifiers = raw.modifiers.map((entry, modifierIndex) =>
          stringValue(entry, context, `${where}.modifiers[${modifierIndex}]`, { nonEmpty: true, maxBytes: 64 })
        );
      }
      const before = raw.before === undefined ? undefined : parseCondition(raw.before, context, `${where}.before`);
      return {
        kind,
        key,
        ...(modifiers !== undefined ? { modifiers } : {}),
        ...(before !== undefined ? { before } : {})
      };
    }
    case "scroll":
      assertKnownKeys(raw, ["kind", "spec"], context, where);
      return { kind, spec: parseScrollSpec(raw.spec, context, `${where}.spec`) };
    case "wait": {
      assertKnownKeys(raw, ["kind", "condition", "timeoutMs"], context, where);
      const timeoutMs = positiveInteger(raw.timeoutMs, context, `${where}.timeoutMs`, MAX_BATCH_TIMEOUT_MS);
      return { kind, condition: parseCondition(raw.condition, context, `${where}.condition`), timeoutMs };
    }
  }
}

function parseBatchRequest(value: unknown, context: ValidationContext, where: string): BatchRequest {
  const raw = requireRecord(value, context, where);
  assertKnownKeys(raw, ["actions", "observe", "timeoutMs", "maxActions"], context, where);
  if (!Array.isArray(raw.actions) || raw.actions.length === 0) {
    fail(context, `${where}.actions`, "must be a non-empty array");
  }
  const requestedMax = raw.maxActions === undefined
    ? undefined
    : positiveInteger(raw.maxActions, context, `${where}.maxActions`, MAX_ACTIONS_LIMIT);
  const maxActions = Math.min(requestedMax ?? DEFAULT_MAX_ACTIONS, MAX_ACTIONS_LIMIT);
  if (raw.actions.length > maxActions) {
    fail(context, `${where}.actions`, `contains ${raw.actions.length} entries but the limit is ${maxActions}`);
  }
  const timeoutMs = raw.timeoutMs === undefined
    ? undefined
    : positiveInteger(raw.timeoutMs, context, `${where}.timeoutMs`, MAX_BATCH_TIMEOUT_MS);
  const actions = raw.actions.map((entry, index) => parseBatchAction(entry, context, index));
  const observe = raw.observe === undefined ? undefined : parseObserveOptions(raw.observe, context, `${where}.observe`);
  return {
    actions,
    ...(observe !== undefined ? { observe } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(requestedMax !== undefined ? { maxActions: requestedMax } : {})
  };
}

function parseSessionOperation(value: unknown, context: ValidationContext, where: string): SessionOperation {
  const raw = requireRecord(value, context, where);
  const kind = enumValue(raw.kind, ["observe", "batch", "exec"] as const, "protocol_operation", `${where}.kind`);
  switch (kind) {
    case "observe":
      assertKnownKeys(raw, ["kind", "options"], context, where);
      return raw.options === undefined
        ? { kind }
        : { kind, options: parseObserveOptions(raw.options, context, `${where}.options`) };
    case "batch":
      assertKnownKeys(raw, ["kind", "request"], context, where);
      return { kind, request: parseBatchRequest(raw.request, context, `${where}.request`) };
    case "exec":
      assertKnownKeys(raw, ["kind", "code", "sourceName", "timeoutMs", "maxActions"], context, where);
      return {
        kind,
        // Code-size and empty-body policy remain a business validation in
        // normalizeExecOptions. Keeping the wire field as an ordinary string
        // preserves the host's structured invalid_code/code_too_large reply.
        code: requiredString(raw, "code", context, where, { maxBytes: MAX_MESSAGE_BYTES }),
        sourceName: requiredString(raw, "sourceName", context, where, { nonEmpty: true, maxBytes: MAX_FIELD_BYTES }),
        timeoutMs: positiveInteger(raw.timeoutMs, context, `${where}.timeoutMs`, EXEC_MAX_TIMEOUT_MS),
        maxActions: positiveInteger(raw.maxActions, context, `${where}.maxActions`, EXEC_MAX_ACTIONS_LIMIT)
      };
  }
}

function parseSessionRequest(value: unknown): SessionRequest {
  const context: ValidationContext = "protocol_request";
  const raw = requireRecord(value, context, "request");
  assertKnownKeys(raw, ["schemaVersion", "sessionId", "generation", "requestId", "operation"], context, "request");
  if (raw.schemaVersion !== PROTOCOL_VERSION) {
    throw new ProtocolError("protocol_version", `request.schemaVersion must be ${PROTOCOL_VERSION} (got: ${String(raw.schemaVersion)})`);
  }
  const sessionId = requiredString(raw, "sessionId", context, "request", { nonEmpty: true, maxBytes: MAX_ID_BYTES });
  const generation = requiredString(raw, "generation", context, "request", { nonEmpty: true, maxBytes: MAX_ID_BYTES });
  const requestId = requiredString(raw, "requestId", context, "request", { nonEmpty: true, maxBytes: MAX_ID_BYTES });
  const operation = parseSessionOperation(raw.operation, context, "request.operation");
  return { schemaVersion: PROTOCOL_VERSION, sessionId, generation, requestId, operation };
}

/** Encode one newline-delimited JSON line. The normalizer is only used for
 * outgoing session requests; generic control replies may contain bigint
 * Target fields that must be stringified by the replacer. */
function encodeLine(value: unknown): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value, (_key, entry) => (typeof entry === "bigint" ? entry.toString() : entry));
  } catch (error) {
    throw new ProtocolError("protocol_encode", `message is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (text === undefined) throw new ProtocolError("protocol_encode", "message is not JSON-serializable");
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
  return encodeLine(parseSessionRequest(request));
}

export function decodeRequest(line: string): SessionRequest {
  return parseSessionRequest(parseJsonLine(line, "protocol_request", "request line"));
}

/** Incremental NDJSON frame reader with the size cap enforced per frame.
 * Decoding is streaming UTF-8: a multibyte sequence split across chunk
 * boundaries survives intact instead of becoming replacement characters.
 * Invalid UTF-8 and oversized frames poison the reader. */
export class FrameReader {
  private decoder = new TextDecoder("utf-8", { fatal: true });
  private buffer = "";
  /** Bytes in the current unterminated frame only. Multiple complete frames
   * may share one socket chunk without sharing a budget. */
  private frameBytes = 0;
  private exceeded = false;

  push(chunk: Buffer | Uint8Array | string): string[] {
    if (this.exceeded) return [];
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
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

function parseError(value: unknown, context: ValidationContext, where: string): { code: string; message: string } {
  const raw = requireRecord(value, context, where);
  assertKnownKeys(raw, ["code", "message"], context, where);
  return {
    code: requiredString(raw, "code", context, where, { nonEmpty: true, maxBytes: MAX_ERROR_BYTES }),
    message: requiredString(raw, "message", context, where, { maxBytes: MAX_ERROR_BYTES })
  };
}

function parseGenericReply(value: unknown): KnownReply {
  const raw = requireRecord(value, "protocol_result", "reply");
  if (raw.schemaVersion !== PROTOCOL_VERSION) {
    throw new ProtocolError("protocol_version", `schemaVersion must be ${PROTOCOL_VERSION} (got: ${String(raw.schemaVersion)})`);
  }
  const requestId = optionalString(raw, "requestId", "protocol_result", "reply", { nonEmpty: true, maxBytes: MAX_ID_BYTES });
  let status: string | undefined;
  if (hasOwn(raw, "status") && raw.status !== undefined) {
    status = enumValue(raw.status, REPLY_STATUSES, "protocol_result", "reply.status");
  }
  const error = raw.error === undefined ? undefined : parseError(raw.error, "protocol_result", "reply.error");
  return {
    ...raw,
    schemaVersion: PROTOCOL_VERSION,
    ...(requestId !== undefined ? { requestId } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(error !== undefined ? { error } : {})
  };
}

/** Decode only the common reply envelope. It intentionally does not infer
 * target locations because the same envelope is used by control replies and
 * arbitrary diagnostic payloads. Business callers should use
 * decodeSessionReply or decodeControlReply. */
export function decodeReply(line: string): {
  schemaVersion: number;
  requestId?: string;
  status?: string;
  error?: { code: string; message: string };
  info?: unknown;
  result?: unknown;
  [key: string]: unknown;
} {
  return parseGenericReply(parseJsonLine(line, "protocol_result", "reply line"));
}

function parseAxFrame(value: unknown, context: ValidationContext, where: string): { x: number; y: number; w: number; h: number } {
  const raw = requireRecord(value, context, where);
  const frame = {
    x: finiteNumber(raw.x, context, `${where}.x`),
    y: finiteNumber(raw.y, context, `${where}.y`),
    w: finiteNumber(raw.w, context, `${where}.w`),
    h: finiteNumber(raw.h, context, `${where}.h`)
  };
  return copyUnknownFields(raw, frame, ["x", "y", "w", "h"]);
}

function parseAxElement(value: unknown, context: ValidationContext, where: string): AxElement {
  const raw = requireRecord(value, context, where);
  const role = optionalString(raw, "role", context, where, { maxBytes: MAX_FIELD_BYTES });
  const label = optionalString(raw, "label", context, where, { maxBytes: MAX_FIELD_BYTES });
  const textValue = optionalString(raw, "value", context, where, { maxBytes: MAX_FIELD_BYTES });
  const elementToken = optionalString(raw, "elementToken", context, where, { maxBytes: MAX_FIELD_BYTES });
  const frame = raw.frame === undefined ? undefined : parseAxFrame(raw.frame, context, `${where}.frame`);
  const enabled = optionalBoolean(raw, "enabled", context, where);
  const selected = optionalBoolean(raw, "selected", context, where);
  const parsed: AxElement = {
    ...(role !== undefined ? { role } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(textValue !== undefined ? { value: textValue } : {}),
    ...(elementToken !== undefined ? { elementToken } : {}),
    ...(frame !== undefined ? { frame } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    ...(selected !== undefined ? { selected } : {})
  };
  return copyUnknownFields(raw, parsed, ["role", "label", "value", "elementToken", "frame", "enabled", "selected"]);
}

function parseAxChannel(value: unknown, context: ValidationContext, where: string): AxChannel {
  const raw = requireRecord(value, context, where);
  const status = enumValue(raw.status, CHANNEL_STATUSES, context, `${where}.status`);
  if (!Array.isArray(raw.elements)) fail(context, `${where}.elements`, "must be an array");
  if (raw.elements.length > MAX_AX_ELEMENTS) fail(context, `${where}.elements`, `may contain at most ${MAX_AX_ELEMENTS} entries`);
  const reason = optionalString(raw, "reason", context, where, { maxBytes: MAX_ERROR_BYTES });
  const total = nonNegativeInteger(raw.total, context, `${where}.total`);
  const returned = nonNegativeInteger(raw.returned, context, `${where}.returned`);
  const complete = requiredBoolean(raw, "complete", context, where);
  const elements = raw.elements.map((entry, index) => parseAxElement(entry, context, `${where}.elements[${index}]`));
  const parsed: AxChannel = {
    status,
    ...(reason !== undefined ? { reason } : {}),
    elements,
    total,
    returned,
    complete
  };
  return copyUnknownFields(raw, parsed, ["status", "reason", "elements", "total", "returned", "complete"]);
}

function parseRect(value: unknown, context: ValidationContext, where: string): Rect {
  const raw = requireRecord(value, context, where);
  const rect: Rect = {
    x: finiteNumber(raw.x, context, `${where}.x`),
    y: finiteNumber(raw.y, context, `${where}.y`),
    width: finiteNumber(raw.width, context, `${where}.width`, { min: Number.MIN_VALUE }),
    height: finiteNumber(raw.height, context, `${where}.height`, { min: Number.MIN_VALUE })
  };
  return copyUnknownFields(raw, rect, ["x", "y", "width", "height"]);
}

function parseDimension(value: unknown, context: ValidationContext, where: string): number {
  return positiveInteger(value, context, where);
}

function parseImageGeometry(value: unknown, context: ValidationContext, where: string): ImageGeometry {
  const raw = requireRecord(value, context, where);
  const geometry: ImageGeometry = {
    sourceWidth: parseDimension(raw.sourceWidth, context, `${where}.sourceWidth`),
    sourceHeight: parseDimension(raw.sourceHeight, context, `${where}.sourceHeight`),
    sentWidth: parseDimension(raw.sentWidth, context, `${where}.sentWidth`),
    sentHeight: parseDimension(raw.sentHeight, context, `${where}.sentHeight`),
    inputBounds: parseRect(raw.inputBounds, context, `${where}.inputBounds`),
    windowBounds: parseRect(raw.windowBounds, context, `${where}.windowBounds`)
  };
  return copyUnknownFields(raw, geometry, ["sourceWidth", "sourceHeight", "sentWidth", "sentHeight", "inputBounds", "windowBounds"]);
}

function parseImageChannel(value: unknown, context: ValidationContext, where: string): ImageChannel {
  const raw = requireRecord(value, context, where);
  const status = enumValue(raw.status, CHANNEL_STATUSES, context, `${where}.status`);
  const reason = optionalString(raw, "reason", context, where, { maxBytes: MAX_ERROR_BYTES });
  const originalPath = optionalString(raw, "originalPath", context, where, { maxBytes: MAX_FIELD_BYTES });
  const path = optionalString(raw, "path", context, where, { maxBytes: MAX_FIELD_BYTES });
  const frameValid = optionalBoolean(raw, "frameValid", context, where);
  const geometry = raw.geometry === undefined ? undefined : parseImageGeometry(raw.geometry, context, `${where}.geometry`);
  const parsed: ImageChannel = {
    status,
    ...(reason !== undefined ? { reason } : {}),
    ...(originalPath !== undefined ? { originalPath } : {}),
    ...(path !== undefined ? { path } : {}),
    ...(frameValid !== undefined ? { frameValid } : {}),
    ...(geometry !== undefined ? { geometry } : {})
  };
  return copyUnknownFields(raw, parsed, ["status", "reason", "originalPath", "path", "frameValid", "geometry"]);
}

function parseObservation(
  value: unknown,
  context: ValidationContext,
  where: string,
  encoding: WindowIdEncoding
): Observation {
  const raw = requireRecord(value, context, where);
  const id = requiredString(raw, "id", context, where, { nonEmpty: true, maxBytes: MAX_ID_BYTES });
  const target = parseTarget(raw.target, context, `${where}.target`, encoding);
  const capturedAt = finiteNumber(raw.capturedAt, context, `${where}.capturedAt`);
  const epoch = requiredString(raw, "epoch", context, where, { nonEmpty: true, maxBytes: MAX_ID_BYTES });
  const revision = nonNegativeInteger(raw.revision, context, `${where}.revision`);
  const title = requiredString(raw, "title", context, where, { maxBytes: MAX_FIELD_BYTES });
  const ax = parseAxChannel(raw.ax, context, `${where}.ax`);
  const image = parseImageChannel(raw.image, context, `${where}.image`);
  // All declared Observation fields above have been validated. Unknown keys
  // are optional forward-compatible metadata and are copied without any
  // recursive id conversion.
  const parsed: Observation = { id, target, capturedAt, epoch, revision, title, ax, image };
  return copyUnknownFields(raw, parsed, ["id", "target", "capturedAt", "epoch", "revision", "title", "ax", "image"]);
}

function parseActionReceipt(value: unknown, context: ValidationContext, where: string): ActionReceipt {
  const raw = requireRecord(value, context, where);
  const index = nonNegativeInteger(raw.index, context, `${where}.index`, MAX_RECEIPTS - 1);
  const kind = enumValue(raw.kind, ACTION_KINDS, context, `${where}.kind`);
  const status = enumValue(raw.status, RECEIPT_STATUSES, context, `${where}.status`);
  const error = raw.error === undefined ? undefined : parseError(raw.error, context, `${where}.error`);
  const parsed: ActionReceipt = {
    index,
    kind,
    status,
    ...(error !== undefined ? { error } : {})
  };
  return copyUnknownFields(raw, parsed, ["index", "kind", "status", "error"]);
}

function parseBatchResult(value: unknown, context: ValidationContext, where: string, encoding: WindowIdEncoding): BatchResult {
  const raw = requireRecord(value, context, where);
  const status = enumValue(raw.status, ["completed", "interrupted", "failed"] as const, context, `${where}.status`);
  if (!Array.isArray(raw.steps)) fail(context, `${where}.steps`, "must be an array");
  if (raw.steps.length > MAX_RECEIPTS) fail(context, `${where}.steps`, `may contain at most ${MAX_RECEIPTS} receipts`);
  const steps = raw.steps.map((entry, index) => parseActionReceipt(entry, context, `${where}.steps[${index}]`));
  const observation = raw.observation === undefined
    ? undefined
    : parseObservation(raw.observation, context, `${where}.observation`, encoding);
  const observationError = raw.observationError === undefined
    ? undefined
    : parseError(raw.observationError, context, `${where}.observationError`);
  const parsed: BatchResult = {
    status,
    steps,
    ...(observation !== undefined ? { observation } : {}),
    ...(observationError !== undefined ? { observationError } : {})
  };
  return copyUnknownFields(raw, parsed, ["status", "steps", "observation", "observationError"]);
}

/** Validate JSON values without transforming them. This is especially
 * important for ExecResult.value: user data may legitimately contain nested
 * `windowId` keys with either text or numeric values. The producer and this
 * consumer call the same validator so a reply cannot become invalid only
 * after the host has committed state. */
function parseJsonValue(value: unknown, context: ValidationContext, where: string): JsonValue {
  try {
    return validateJsonValue(value, EXEC_MAX_STATE_BYTES, { rootPath: where });
  } catch (error) {
    if (error instanceof JsonValueValidationError) {
      fail(context, error.path, error.reason);
    }
    fail(context, where, error instanceof Error ? error.message : String(error));
  }
}

function parseExecResult(value: unknown, context: ValidationContext, where: string, encoding: WindowIdEncoding): ExecResult {
  const raw = requireRecord(value, context, where);
  const status = enumValue(raw.status, EXEC_STATUSES, context, `${where}.status`);
  const stateVersion = nonNegativeInteger(raw.stateVersion, context, `${where}.stateVersion`);
  const stateCommitted = requiredBoolean(raw, "stateCommitted", context, where);
  // stateHash is an optional diagnostic field. Validate its declared string
  // shape, but do not make a future hash representation a wire incompatibility.
  const stateHash = optionalString(raw, "stateHash", context, where, { nonEmpty: true, maxBytes: 128 });
  if (!Array.isArray(raw.actions)) fail(context, `${where}.actions`, "must be an array");
  if (raw.actions.length > MAX_RECEIPTS) fail(context, `${where}.actions`, `may contain at most ${MAX_RECEIPTS} receipts`);
  if (!Array.isArray(raw.observations)) fail(context, `${where}.observations`, "must be an array");
  if (raw.observations.length > EXEC_MAX_OBSERVATIONS) {
    fail(context, `${where}.observations`, `may contain at most ${EXEC_MAX_OBSERVATIONS} observations`);
  }
  if (!Array.isArray(raw.logs)) fail(context, `${where}.logs`, "must be an array");
  let logBytes = 0;
  const logs = raw.logs.map((entry, index) => {
    const line = stringValue(entry, context, `${where}.logs[${index}]`, { maxBytes: EXEC_MAX_LOG_BYTES });
    logBytes += Buffer.byteLength(line, "utf8") + 1;
    if (logBytes > EXEC_MAX_LOG_BYTES) fail(context, `${where}.logs`, `exceeds ${EXEC_MAX_LOG_BYTES} UTF-8 bytes`);
    return line;
  });
  const actions = raw.actions.map((entry, index) => parseActionReceipt(entry, context, `${where}.actions[${index}]`));
  const observations = raw.observations.map((entry, index) => parseObservation(entry, context, `${where}.observations[${index}]`, encoding));
  const observationsDropped = raw.observationsDropped === undefined
    ? undefined
    : nonNegativeInteger(raw.observationsDropped, context, `${where}.observationsDropped`, MAX_RECEIPTS);
  const error = raw.error === undefined ? undefined : parseError(raw.error, context, `${where}.error`);
  let validatedValue: JsonValue | undefined;
  if (hasOwn(raw, "value")) {
    validatedValue = parseJsonValue(raw.value, context, `${where}.value`);
    const encodedValue = JSON.stringify(validatedValue);
    if (encodedValue === undefined || Buffer.byteLength(encodedValue, "utf8") > EXEC_MAX_STATE_BYTES) {
      fail(context, `${where}.value`, `exceeds ${EXEC_MAX_STATE_BYTES} UTF-8 bytes`);
    }
  }
  const parsed: ExecResult = {
    status,
    ...(validatedValue !== undefined ? { value: validatedValue } : {}),
    stateVersion,
    stateCommitted,
    ...(stateHash !== undefined ? { stateHash } : {}),
    actions,
    observations,
    ...(observationsDropped !== undefined ? { observationsDropped } : {}),
    logs,
    ...(error !== undefined ? { error } : {})
  };
  return copyUnknownFields(raw, parsed, [
    "status",
    "value",
    "stateVersion",
    "stateCommitted",
    "stateHash",
    "actions",
    "observations",
    "observationsDropped",
    "logs",
    "error"
  ]);
}

function parseControlInfo(value: unknown): SessionInfo {
  const context: ValidationContext = "protocol_control";
  const raw = requireRecord(value, context, "reply.info");
  const id = requiredString(raw, "id", context, "reply.info", { nonEmpty: true, maxBytes: MAX_ID_BYTES });
  const target = parseSessionTarget(raw.target, context, "reply.info.target");
  const state = enumValue(raw.state, SESSION_STATES, context, "reply.info.state");
  const activeRequestId = optionalString(raw, "activeRequestId", context, "reply.info", { nonEmpty: true, maxBytes: MAX_ID_BYTES });
  const hostPid = parsePid(raw.hostPid, context, "reply.info.hostPid");
  const generation = requiredString(raw, "generation", context, "reply.info", { nonEmpty: true, maxBytes: MAX_ID_BYTES });
  const idleTimeoutMs = positiveInteger(raw.idleTimeoutMs, context, "reply.info.idleTimeoutMs", 120_000);
  const parsed: SessionInfo = {
    id,
    target,
    state,
    ...(activeRequestId !== undefined ? { activeRequestId } : {}),
    hostPid,
    generation,
    idleTimeoutMs
  };
  return copyUnknownFields(raw, parsed, ["id", "target", "state", "activeRequestId", "hostPid", "generation", "idleTimeoutMs"]);
}

/** Decode a control-plane reply. Target ids in SessionInfo remain decimal
 * strings because SessionInfo is the public wire-facing type. */
export function decodeControlReply(line: string): SessionControlReply {
  const raw = decodeReply(line);
  if (raw.requestId !== undefined || raw.status !== undefined || raw.result !== undefined) {
    throw new ProtocolError("protocol_control", "control reply cannot contain a business requestId, status, or result");
  }
  const info = raw.info === undefined ? undefined : parseControlInfo(raw.info);
  const reply: SessionControlReply = {
    schemaVersion: PROTOCOL_VERSION,
    ...(info !== undefined ? { info } : {}),
    ...(raw.error !== undefined ? { error: raw.error } : {})
  };
  return copyUnknownFields(raw, reply, ["schemaVersion", "info", "error"]);
}

/** Decode a business reply using its declared operation schema. This is the
 * only public result decoder that restores observation Target window ids. */
export function decodeSessionReply(line: string, operation: SessionOperation): SessionReply {
  const raw = decodeReply(line);
  const requestId = requiredString(raw, "requestId", "protocol_result", "business reply", { nonEmpty: true, maxBytes: MAX_ID_BYTES });
  const status = enumValue(raw.status, REPLY_STATUSES, "protocol_result", "business reply.status");
  if (raw.result === undefined) {
    if (status === "completed") {
      throw new ProtocolError("protocol_result", `completed ${operation.kind} reply is missing result`);
    }
    const reply: SessionReply = {
      schemaVersion: PROTOCOL_VERSION,
      requestId,
      status,
      ...(raw.error !== undefined ? { error: raw.error } : {})
    };
    return copyUnknownFields(raw, reply, ["schemaVersion", "requestId", "status", "error", "result"]);
  }
  let result: unknown;
  switch (operation.kind) {
    case "observe":
      result = parseObservation(raw.result, "protocol_result", "reply.result", "wire");
      break;
    case "batch":
      result = parseBatchResult(raw.result, "protocol_result", "reply.result", "wire");
      break;
    case "exec":
      result = parseExecResult(raw.result, "protocol_result", "reply.result", "wire");
      break;
    default:
      throw new ProtocolError("protocol_operation", `unsupported operation kind: ${String((operation as { kind?: unknown }).kind)}`);
  }
  const reply: SessionReply = {
    schemaVersion: PROTOCOL_VERSION,
    requestId,
    status,
    result,
    ...(raw.error !== undefined ? { error: raw.error } : {})
  };
  return copyUnknownFields(raw, reply, ["schemaVersion", "requestId", "status", "error", "result"]);
}

/** Decode a host RPC observation after the worker-side wire conversion. */
export function decodeObservationValue(value: unknown): Observation {
  return parseObservation(value, "protocol_rpc", "rpc.observation", "native");
}

/** Decode the result of the strict AX-only value-write RPC. */
export function decodeAxValueResult(value: unknown): AxValueResult {
  const context: ValidationContext = "protocol_rpc";
  const where = "rpc.set_value";
  const raw = requireRecord(value, context, where);
  assertKnownKeys(raw, ["route", "effect", "delivery"], context, where);
  if (raw.route !== "accessibility") fail(context, `${where}.route`, "must be accessibility");
  if (raw.effect !== "confirmed") fail(context, `${where}.effect`, "must be confirmed");
  if (raw.delivery === undefined || raw.delivery === null) return { route: "accessibility", effect: "confirmed" };
  const deliveryRaw = requireRecord(raw.delivery, context, `${where}.delivery`);
  assertKnownKeys(deliveryRaw, ["mode", "deliveredCount"], context, `${where}.delivery`);
  const mode = deliveryRaw.mode === undefined
    ? undefined
    : enumValue(deliveryRaw.mode, ["not_applicable", "background", "foreground", "unknown"] as const, context, `${where}.delivery.mode`);
  const deliveredCount = deliveryRaw.deliveredCount === undefined || deliveryRaw.deliveredCount === null
    ? deliveryRaw.deliveredCount
    : nonNegativeInteger(deliveryRaw.deliveredCount, context, `${where}.delivery.deliveredCount`);
  return {
    route: "accessibility",
    effect: "confirmed",
    delivery: {
      ...(mode !== undefined ? { mode } : {}),
      ...(deliveredCount !== undefined ? { deliveredCount } : {})
    }
  };
}

/** Decode a host RPC batch after the worker-side wire conversion. */
export function decodeBatchResultValue(value: unknown): BatchResult {
  return parseBatchResult(value, "protocol_rpc", "rpc.batch", "native");
}

function looksLikeObservation(value: unknown): value is Record<string, unknown> {
  return isRecord(value) &&
    hasOwn(value, "id") && hasOwn(value, "target") && hasOwn(value, "capturedAt") &&
    hasOwn(value, "epoch") && hasOwn(value, "revision") && hasOwn(value, "title") &&
    hasOwn(value, "ax") && hasOwn(value, "image");
}

function looksLikeBatchResult(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && hasOwn(value, "status") && hasOwn(value, "steps") && Array.isArray(value.steps) &&
    (value.status === "completed" || value.status === "interrupted" || value.status === "failed");
}

function looksLikeExecResult(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && hasOwn(value, "status") && hasOwn(value, "stateVersion") &&
    hasOwn(value, "stateCommitted") && hasOwn(value, "actions") && hasOwn(value, "observations") && hasOwn(value, "logs");
}

/**
 * Restore ids only in known runtime result schemas.  This function remains a
 * compatibility seam for the exec worker, whose host RPC callback does not
 * carry an operation discriminator.  Unknown objects are returned unchanged;
 * arbitrary user data is never recursively rewritten.
 */
export function deepRestoreWindowIds(value: unknown, hint?: "observe" | "batch" | "exec"): unknown {
  if (hint === "observe" || (!hint && looksLikeObservation(value))) {
    return parseObservation(value, "protocol_rpc", "rpc.observation", "wire");
  }
  if (hint === "batch" || (!hint && looksLikeBatchResult(value))) {
    return parseBatchResult(value, "protocol_rpc", "rpc.batch", "wire");
  }
  if (hint === "exec" || (!hint && looksLikeExecResult(value))) {
    return parseExecResult(value, "protocol_rpc", "rpc.exec", "wire");
  }
  return value;
}
