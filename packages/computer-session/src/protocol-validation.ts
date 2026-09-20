// Primitive wire validation. Domain schemas stay in protocol.ts.

export const MAX_FIELD_BYTES = 256 * 1024;

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

export type ValidationContext = "protocol_request" | "protocol_operation" | "protocol_result" | "protocol_control" | "protocol_rpc";
export function fail(context: ValidationContext, where: string, message: string): never {
  throw new ProtocolError(context, `${where}: ${message}`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function requireRecord(value: unknown, context: ValidationContext, where: string): Record<string, unknown> {
  if (!isRecord(value)) fail(context, where, "must be an object");
  return value;
}

export function assertKnownKeys(
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
export function copyUnknownFields<T extends object>(
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

export function stringValue(
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

export function requiredString(
  value: Record<string, unknown>,
  key: string,
  context: ValidationContext,
  where: string,
  options: { nonEmpty?: boolean; maxBytes?: number } = {}
): string {
  if (!hasOwn(value, key) || value[key] === undefined) fail(context, `${where}.${key}`, "is required");
  return stringValue(value[key], context, `${where}.${key}`, options);
}

export function optionalString(
  value: Record<string, unknown>,
  key: string,
  context: ValidationContext,
  where: string,
  options: { nonEmpty?: boolean; maxBytes?: number } = {}
): string | undefined {
  if (!hasOwn(value, key) || value[key] === undefined) return undefined;
  return stringValue(value[key], context, `${where}.${key}`, options);
}

export function finiteNumber(
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

export function enumValue<T extends string>(
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

export function optionalBoolean(
  value: Record<string, unknown>,
  key: string,
  context: ValidationContext,
  where: string
): boolean | undefined {
  if (!hasOwn(value, key) || value[key] === undefined) return undefined;
  if (typeof value[key] !== "boolean") fail(context, `${where}.${key}`, "must be a boolean");
  return value[key] as boolean;
}

export function requiredBoolean(value: Record<string, unknown>, key: string, context: ValidationContext, where: string): boolean {
  if (!hasOwn(value, key) || typeof value[key] !== "boolean") fail(context, `${where}.${key}`, "must be a boolean");
  return value[key] as boolean;
}

export function nonNegativeInteger(value: unknown, context: ValidationContext, where: string, max?: number): number {
  return finiteNumber(value, context, where, { integer: true, min: 0, ...(max !== undefined ? { max } : {}) });
}

export function positiveInteger(value: unknown, context: ValidationContext, where: string, max?: number): number {
  return finiteNumber(value, context, where, { integer: true, min: 1, ...(max !== undefined ? { max } : {}) });
}

