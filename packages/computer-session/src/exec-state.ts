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
import { validateJsonValue } from "./json-value.js";

export { validateJsonValue } from "./json-value.js";

export interface ExecStateFile {
  version: number;
  value: Record<string, JsonValue>;
  /** Hash makes a state file self-checking during journal recovery. */
  hash?: string;
  /** Durable owner of this committed version, when written by a hosted exec. */
  requestId?: string;
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
    Array.isArray(parsed.value) ||
    (parsed.requestId !== undefined &&
      (typeof parsed.requestId !== "string" || parsed.requestId.length === 0))
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
): { version: number; value: Record<string, JsonValue>; hash: string; requestId?: string } {
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
  return {
    version,
    value: parsed.value,
    hash: execStateHash(parsed.value),
    ...(parsed.requestId !== undefined ? { requestId: parsed.requestId } : {})
  };
}

/** Commit with optimistic version check: only the expected writer wins. */
export function commitExecState(
  directory: string,
  expectedVersion: number,
  value: Record<string, JsonValue>,
  requestId?: string
): number {
  // State is an object contract, not an arbitrary JsonValue. Validate both
  // shape and contents before creating or replacing any state file so a
  // producer cannot send a valid array/scalar that the durable reader rejects
  // only on the next request.
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("exec state must be a plain JSON object");
  }
  validateJsonValue(value, EXEC_MAX_STATE_BYTES);
  if (requestId !== undefined && (typeof requestId !== "string" || requestId.length === 0)) {
    throw new Error("state commit requestId must be a non-empty string");
  }
  const hash = execStateHash(value);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const current = loadExecState(directory);
  if (current.version !== expectedVersion) {
    throw new Error(
      `state version conflict: expected ${expectedVersion}, found ${current.version} — concurrent writers are impossible; the session state is inconsistent`
    );
  }
  const next: ExecStateFile = {
    version: expectedVersion + 1,
    value,
    hash,
    ...(requestId !== undefined ? { requestId } : {})
  };
  const file = statePath(directory);
  const history = join(directory, HISTORY_DIR);
  mkdirSync(history, { recursive: true, mode: 0o700 });
  const historyFile = historyPath(directory, next.version);
  // The history snapshot is written before the current head. If a process
  // dies between these renames, recovery sees an unreferenced history entry
  // and refuses new admission instead of guessing whether the commit landed.
  if (existsSync(historyFile)) {
    const existing = readStateFile(historyFile);
    if (
      existing.version !== next.version ||
      execStateHash(existing.value) !== next.hash ||
      existing.requestId !== next.requestId
    ) {
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
