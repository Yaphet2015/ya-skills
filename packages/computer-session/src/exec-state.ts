// Exec state (C2): explicit JSON state persisted by the HOST only — the
// worker receives a snapshot and reports a candidate final value; commits
// happen exclusively on clean completions with all RPCs settled. Atomic
// tmp+rename; versions only ever move forward; validation fails loud on
// NaN/Infinity/bigint/functions/cycles (JSON.stringify would silently mangle
// or drop them).

import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { JsonValue } from "./exec-types.js";
import { EXEC_MAX_STATE_BYTES } from "./exec-types.js";

export function validateJsonValue(value: unknown, maxBytes: number): JsonValue {
  // Reject non-JSON-legal leaves first (NaN/Infinity/bigint/function/undefined
  // object values), then cycle-check, then enforce the byte budget.
  const seen = new WeakSet<object>();
  const walk = (node: unknown, path: string): JsonValue => {
    if (node === null) return null;
    switch (typeof node) {
      case "boolean":
      case "string":
        return node;
      case "number":
        if (!Number.isFinite(node)) {
          throw new Error(`${path}: numbers must be finite (got ${node})`);
        }
        return node;
      case "bigint":
        throw new Error(`${path}: bigint is not valid state — use strings`);
      case "function":
      case "symbol":
      case "undefined":
        throw new Error(`${path}: ${typeof node} is not valid state`);
      case "object": {
        if (seen.has(node as object)) {
          throw new Error(`${path}: circular reference in state`);
        }
        seen.add(node as object);
        try {
          if (Array.isArray(node)) {
            const values: JsonValue[] = [];
            for (let i = 0; i < node.length; i++) {
              if (!Object.prototype.hasOwnProperty.call(node, i)) {
                throw new Error(`${path}[${i}]: sparse array entries are not valid JSON state`);
              }
              values.push(walk(node[i], `${path}[${i}]`));
            }
            return values;
          }
          // Class instances (Date, Map, custom...) must NOT silently degrade
          // to "{}" via JSON round-tripping — state is plain JSON data only.
          const proto = Object.getPrototypeOf(node as object);
          if (proto !== Object.prototype && proto !== null) {
            throw new Error(
              `${path}: class instances are not valid state — state is plain JSON data (convert dates to ISO strings explicitly)`
            );
          }
          const out: { [key: string]: JsonValue } = {};
          for (const [key, entry] of Object.entries(node as Record<string, unknown>)) {
            out[key] = walk(entry, `${path}.${key}`);
          }
          return out;
        } finally {
          // `seen` is the active recursion stack, not a global visited set:
          // the same acyclic object may legitimately be referenced twice.
          seen.delete(node as object);
        }
      }
      default:
        throw new Error(`${path}: unsupported value`);
    }
  };
  const validated = walk(value, "state");
  const encoded = JSON.stringify(validated);
  if (encoded === undefined) {
    throw new Error("state is not JSON-serializable");
  }
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) {
    throw new Error(`state is ${Buffer.byteLength(encoded, "utf8")} bytes (limit ${maxBytes})`);
  }
  return validated;
}

export interface ExecStateFile {
  version: number;
  value: Record<string, JsonValue>;
  /** Hash makes a state file self-checking during journal recovery. */
  hash?: string;
}

const HISTORY_DIR = "history";

function statePath(directory: string): string {
  return join(directory, "state.json");
}

function historyPath(directory: string, version: number): string {
  return join(directory, HISTORY_DIR, `state-${version}.json`);
}

function readStateFile(file: string): ExecStateFile {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as ExecStateFile;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Number.isSafeInteger(parsed.version) ||
    parsed.version < 0 ||
    typeof parsed.value !== "object" ||
    parsed.value === null ||
    Array.isArray(parsed.value)
  ) {
    throw new Error(`corrupt state file ${file} — refusing to guess; the session must be reset explicitly`);
  }
  try {
    validateJsonValue(parsed.value, EXEC_MAX_STATE_BYTES);
    const actualHash = execStateHash(parsed.value);
    if (parsed.hash !== undefined && parsed.hash !== actualHash) {
      throw new Error(`state hash mismatch (recorded ${parsed.hash}, actual ${actualHash})`);
    }
  } catch (error) {
    throw new Error(`corrupt state file ${file} — ${error instanceof Error ? error.message : String(error)}`);
  }
  return { ...parsed, hash: execStateHash(parsed.value) };
}

export function execStateHash(value: Record<string, JsonValue>): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("state is not JSON-serializable");
  return createHash("sha256").update(encoded, "utf8").digest("hex");
}

export function loadExecState(directory: string): { version: number; value: Record<string, JsonValue> } {
  const file = statePath(directory);
  if (!existsSync(file)) {
    return { version: 0, value: {} };
  }
  const parsed = readStateFile(file);
  return { version: parsed.version, value: parsed.value };
}

/** Read a committed historical snapshot, not just the current state head.
 * Duplicate request replies remain verifiable after later execs advance the
 * session state. Version zero is the implicit empty initial snapshot. */
export function loadExecStateVersion(
  directory: string,
  version: number
): { version: number; value: Record<string, JsonValue>; hash: string } {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error(`invalid state version ${version}`);
  }
  if (version === 0 && !existsSync(statePath(directory))) {
    return { version: 0, value: {}, hash: execStateHash({}) };
  }
  const current = loadExecState(directory);
  const file = version === current.version ? statePath(directory) : historyPath(directory, version);
  if (!existsSync(file)) {
    throw new Error(`missing committed state history version ${version}`);
  }
  const parsed = readStateFile(file);
  if (parsed.version !== version) {
    throw new Error(`state history version mismatch: requested ${version}, found ${parsed.version}`);
  }
  return { version, value: parsed.value, hash: execStateHash(parsed.value) };
}

/** Commit with optimistic version check: only the expected writer wins. */
export function commitExecState(
  directory: string,
  expectedVersion: number,
  value: Record<string, JsonValue>
): number {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const current = loadExecState(directory);
  if (current.version !== expectedVersion) {
    throw new Error(
      `state version conflict: expected ${expectedVersion}, found ${current.version} — concurrent writers are impossible; the session state is inconsistent`
    );
  }
  validateJsonValue(value, EXEC_MAX_STATE_BYTES);
  const next: ExecStateFile = { version: expectedVersion + 1, value, hash: execStateHash(value) };
  const file = statePath(directory);
  const history = join(directory, HISTORY_DIR);
  mkdirSync(history, { recursive: true, mode: 0o700 });
  const historyFile = historyPath(directory, next.version);
  // The history snapshot is written before the current head. If a process
  // dies between these renames, recovery sees an unreferenced history entry
  // and refuses new admission instead of guessing whether the commit landed.
  if (existsSync(historyFile)) {
    const existing = readStateFile(historyFile);
    if (existing.version !== next.version || execStateHash(existing.value) !== next.hash) {
      throw new Error(`state history version ${next.version} already contains a different commit`);
    }
  } else {
    const historyTmp = `${historyFile}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(historyTmp, JSON.stringify(next), { mode: 0o600 });
    renameSync(historyTmp, historyFile);
  }
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
  renameSync(tmp, file);
  return next.version;
}
