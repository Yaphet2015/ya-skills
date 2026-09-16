// Shared JSON-value validation for the exec producer and every protocol
// consumer. Keeping traversal, depth, and byte rules here prevents a value
// accepted by the worker from being rejected only after a host-side commit.

import type { JsonValue } from "./exec-types.js";

/** Bound recursive JSON traversal without rejecting ordinary small payloads. */
export const MAX_JSON_DEPTH = 256;

export class JsonValueValidationError extends Error {
  constructor(
    public readonly path: string,
    public readonly reason: string
  ) {
    super(`${path}: ${reason}`);
    this.name = "JsonValueValidationError";
  }
}

function invalid(path: string, reason: string): never {
  throw new JsonValueValidationError(path, reason);
}

export interface JsonValueValidationOptions {
  /** Path used in diagnostics by protocol consumers. */
  rootPath?: string;
  /** Internal override for focused tests; production uses MAX_JSON_DEPTH. */
  maxDepth?: number;
}

/**
 * Validate and normalize a value to the exact JSON subset used by exec state
 * and wire replies. No JSON.stringify round trip is used for validation: it
 * would silently omit undefined object fields, turn non-finite numbers into
 * null, and degrade class instances.
 */
export function validateJsonValue(
  value: unknown,
  maxBytes: number,
  options: JsonValueValidationOptions = {}
): JsonValue {
  const seen = new WeakSet<object>();
  const maxDepth = options.maxDepth ?? MAX_JSON_DEPTH;
  const rootPath = options.rootPath ?? "state";
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
    throw new Error(`maxDepth must be a non-negative safe integer (got ${String(maxDepth)})`);
  }
  const walk = (node: unknown, path: string, depth: number): JsonValue => {
    if (depth > maxDepth) invalid(path, `exceeds maximum JSON nesting depth ${maxDepth}`);
    if (node === null) return null;
    switch (typeof node) {
      case "boolean":
      case "string":
        return node;
      case "number":
        if (!Number.isFinite(node)) invalid(path, `numbers must be finite (got ${node})`);
        return node;
      case "bigint":
        invalid(path, "bigint is not valid JSON state — use strings");
      case "function":
      case "symbol":
      case "undefined":
        invalid(path, `${typeof node} is not valid JSON state`);
      case "object": {
        if (seen.has(node as object)) invalid(path, "circular reference in JSON state");
        seen.add(node as object);
        try {
          if (Array.isArray(node)) {
            const values: JsonValue[] = [];
            for (let index = 0; index < node.length; index++) {
              if (!Object.prototype.hasOwnProperty.call(node, index)) {
                invalid(`${path}[${index}]`, "sparse array entries are not valid JSON state");
              }
              values.push(walk(node[index], `${path}[${index}]`, depth + 1));
            }
            return values;
          }
          // Class instances (Date, Map, custom...) must not silently degrade
          // to "{}" through JSON.stringify. State is plain JSON data only.
          const proto = Object.getPrototypeOf(node as object);
          if (proto !== Object.prototype && proto !== null) {
            invalid(path, "class instances are not valid JSON state — convert dates to ISO strings explicitly");
          }
          const output: { [key: string]: JsonValue } = {};
          for (const [key, entry] of Object.entries(node as Record<string, unknown>)) {
            output[key] = walk(entry, `${path}.${key}`, depth + 1);
          }
          return output;
        } finally {
          // `seen` is the active recursion stack, not a global visited set:
          // the same acyclic object may legitimately be referenced twice.
          seen.delete(node as object);
        }
      }
      default:
        invalid(path, "unsupported value");
    }
  };
  const validated = walk(value, rootPath, 0);
  const encoded = JSON.stringify(validated);
  if (encoded === undefined) throw new Error("value is not JSON-serializable");
  const bytes = Buffer.byteLength(encoded, "utf8");
  if (!Number.isFinite(maxBytes) || maxBytes < 0 || bytes > maxBytes) {
    throw new Error(`${rootPath} is ${bytes} bytes (limit ${maxBytes})`);
  }
  return validated;
}
