// The session ledger is the authoritative terminal storage seam. One
// immutable terminal record contains the request result and, when present,
// its next exec state.
// state.json and history/ are derived compatibility snapshots. The ledger does
// not append to a shared file and it never uses a snapshot to prove delivery.

import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ExecResult, JsonValue } from "./exec-types.js";
import { EXEC_MAX_STATE_BYTES } from "./exec-types.js";
import { validateJsonValue } from "./json-value.js";

export const SESSION_LEDGER_SCHEMA_VERSION = 1 as const;
export const SESSION_LEDGER_DIRECTORY = "transactions" as const;

export type LedgerRequestStatus = "completed" | "failed" | "interrupted" | "unknown";

export interface LedgerRequestError {
  code: string;
  message: string;
}

export interface LedgerStateSnapshot {
  expectedVersion: number;
  version: number;
  value: Record<string, JsonValue>;
  hash: string;
  requestId: string;
}

/** The authoritative terminal request result plus an optional new state. */
export interface SessionTransactionRecord {
  schemaVersion: typeof SESSION_LEDGER_SCHEMA_VERSION;
  requestId: string;
  requestHash: string;
  status: LedgerRequestStatus;
  result?: unknown;
  error?: LedgerRequestError;
  state?: LedgerStateSnapshot;
  recordHash: string;
}

export type SessionTransactionInput = Omit<SessionTransactionRecord, "recordHash">;

export interface LedgerStateCommit {
  result: ExecResult;
  version: number;
  hash: string;
  record: SessionTransactionRecord;
}

export interface SessionLedger {
  read(requestId: string): SessionTransactionRecord | undefined;
  list(): SessionTransactionRecord[];
  commit(record: SessionTransactionInput): SessionTransactionRecord;
  readState(): LedgerStateSnapshot;
  readStateVersion(version: number): LedgerStateSnapshot;
  verify(requestId: string, requestHash?: string): boolean;
  commitState(
    requestId: string,
    requestHash: string,
    expectedVersion: number,
    state: Record<string, JsonValue>,
    result: ExecResult
  ): LedgerStateCommit;
}

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const HISTORY_DIRECTORY = "history";

function assertRequestId(id: string): void {
  if (!REQUEST_ID_RE.test(id)) throw new Error(`request id must match ${REQUEST_ID_RE} (got: ${id})`);
}

function assertVersion(version: number, label: string): void {
  if (!Number.isSafeInteger(version) || version < 0) throw new Error(`${label} must be a non-negative safe integer`);
}

function transactionsDir(root: string): string {
  return join(root, SESSION_LEDGER_DIRECTORY);
}

function transactionPath(root: string, id: string): string {
  assertRequestId(id);
  return join(transactionsDir(root), `${id}.json`);
}

function statePath(root: string): string {
  return join(root, "state.json");
}

function historyPath(root: string, version: number): string {
  return join(root, HISTORY_DIRECTORY, `state-${version}.json`);
}

function encode(value: unknown, context: string): string {
  try {
    const text = JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
    if (text === undefined) throw new Error("value is undefined");
    return text;
  } catch (error) {
    throw new Error(`${context} is not JSON-serializable — ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function hashJsonObject(value: Record<string, JsonValue>): string {
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error("state is not JSON-serializable");
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function recordPayload(record: SessionTransactionInput): SessionTransactionInput {
  return {
    schemaVersion: record.schemaVersion,
    requestId: record.requestId,
    requestHash: record.requestHash,
    status: record.status,
    ...(record.result !== undefined ? { result: record.result } : {}),
    ...(record.error !== undefined ? { error: record.error } : {}),
    ...(record.state !== undefined ? { state: record.state } : {})
  };
}

function digest(record: SessionTransactionInput): string {
  return createHash("sha256").update(encode(recordPayload(record), "session transaction"), "utf8").digest("hex");
}

function validateState(state: LedgerStateSnapshot, owner: string): void {
  if (typeof state !== "object" || state === null || Array.isArray(state)) throw new Error("transaction state must be an object");
  assertVersion(state.expectedVersion, "transaction expectedVersion");
  if (!Number.isSafeInteger(state.version) || state.version < 1 || state.version !== state.expectedVersion + 1) {
    throw new Error("transaction state version is invalid");
  }
  if (state.requestId !== owner || state.requestId.length === 0) throw new Error("transaction state owner does not match requestId");
  if (typeof state.hash !== "string" || !HASH_RE.test(state.hash)) throw new Error("transaction state hash is invalid");
  if (typeof state.value !== "object" || state.value === null || Array.isArray(state.value)) {
    throw new Error("transaction state value must be a plain JSON object");
  }
  validateJsonValue(state.value, EXEC_MAX_STATE_BYTES);
  const actual = hashJsonObject(state.value);
  if (actual !== state.hash) throw new Error(`transaction state hash mismatch (recorded ${state.hash}, actual ${actual})`);
}

function assertStateAdvanceResult(result: unknown): void {
  const value = typeof result === "object" && result !== null
    ? result as { status?: unknown; error?: { code?: unknown } }
    : undefined;
  const finalObservationFailure = value?.status === "failed" && value.error?.code === "final_observe_failed";
  if (value?.status !== "completed" && !finalObservationFailure) {
    throw new Error("only completed exec results or failed final_observe_failed results may commit state");
  }
}

function validateRecord(record: SessionTransactionInput): void {
  if (record.schemaVersion !== SESSION_LEDGER_SCHEMA_VERSION) {
    throw new Error(`unsupported transaction schemaVersion ${String(record.schemaVersion)}`);
  }
  assertRequestId(record.requestId);
  if (typeof record.requestHash !== "string" || record.requestHash.length === 0) throw new Error("transaction requestHash is empty");
  if (!["completed", "failed", "interrupted", "unknown"].includes(record.status)) {
    throw new Error(`transaction status is invalid: ${String(record.status)}`);
  }
  if (record.error !== undefined &&
      (typeof record.error !== "object" || record.error === null || typeof record.error.code !== "string" || typeof record.error.message !== "string")) {
    throw new Error("transaction error is invalid");
  }
  if (record.result !== undefined) validateJsonValue(JSON.parse(encode(record.result, "transaction result")), 4 * 1024 * 1024, { rootPath: "result" });
  if (record.state !== undefined) validateState(record.state, record.requestId);
  if (record.state !== undefined && record.result === undefined) throw new Error("transaction state requires a result");
  if (record.state !== undefined) assertStateAdvanceResult(record.result);
}

function canonical(record: SessionTransactionInput): SessionTransactionRecord {
  validateRecord(record);
  return { ...recordPayload(record), recordHash: digest(record) };
}

function parseRecord(text: string, id: string, file: string): SessionTransactionRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`corrupt session transaction ${file} — ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`corrupt session transaction ${file} — record is not an object`);
  const parsed = raw as Partial<SessionTransactionRecord>;
  if (parsed.requestId !== id || typeof parsed.recordHash !== "string" || !HASH_RE.test(parsed.recordHash)) {
    throw new Error(`corrupt session transaction ${file} — identity or recordHash is invalid`);
  }
  const payload = { ...parsed } as SessionTransactionInput;
  delete (payload as Partial<SessionTransactionRecord>).recordHash;
  try {
    validateRecord(payload);
  } catch (error) {
    throw new Error(`corrupt session transaction ${file} — ${error instanceof Error ? error.message : String(error)}`);
  }
  if (digest(payload) !== parsed.recordHash) throw new Error(`corrupt session transaction ${file} — record hash mismatch`);
  return canonical(payload);
}

function readRecord(root: string, id: string): SessionTransactionRecord | undefined {
  const file = transactionPath(root, id);
  return existsSync(file) ? parseRecord(readFileSync(file, "utf8"), id, file) : undefined;
}

function readRecords(root: string): SessionTransactionRecord[] {
  const directory = transactionsDir(root);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json") && REQUEST_ID_RE.test(name.slice(0, -5)))
    .map((name) => {
      const id = name.slice(0, -5);
      return parseRecord(readFileSync(join(directory, name), "utf8"), id, join(directory, name));
    })
    .sort((a, b) => a.requestId.localeCompare(b.requestId));
}

function writeAtomic(file: string, text: string): void {
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, text, { mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    try { unlinkSync(temporary); } catch { /* rename completed */ }
  }
}

function installImmutable(file: string, text: string): void {
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, text, { mode: 0o600 });
    try {
      // Link the complete inode into place so a duplicate cannot replace the
      // winner. Rename remains the fallback for filesystems without links.
      linkSync(temporary, file);
      unlinkSync(temporary);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") throw error;
      if (code !== "EPERM" && code !== "EXDEV" && code !== "EOPNOTSUPP") throw error;
      if (existsSync(file)) throw Object.assign(new Error("record already exists"), { code: "EEXIST" });
      renameSync(temporary, file);
    }
  } finally {
    try { unlinkSync(temporary); } catch { /* installed or renamed */ }
  }
}

export interface StateFileSnapshot {
  version: number;
  value: Record<string, JsonValue>;
  hash: string;
  requestId?: string;
}

/** Existing state files keep their fail-loud corruption contract. */
export function readStateFile(file: string): StateFileSnapshot {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { throw new Error(`corrupt state file ${file} — ${error instanceof Error ? error.message : String(error)}`); }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`corrupt state file ${file} — refusing to guess; the session must be reset explicitly`);
  const parsed = raw as { version?: unknown; value?: unknown; hash?: unknown; requestId?: unknown };
  if (!Number.isSafeInteger(parsed.version) || (parsed.version as number) < 0 || typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value) ||
      (parsed.requestId !== undefined && (typeof parsed.requestId !== "string" || parsed.requestId.length === 0))) {
    throw new Error(`corrupt state file ${file} — refusing to guess; the session must be reset explicitly`);
  }
  try {
    const value = parsed.value as Record<string, JsonValue>;
    validateJsonValue(value, EXEC_MAX_STATE_BYTES);
    const hash = hashJsonObject(value);
    if (parsed.hash !== undefined && parsed.hash !== hash) throw new Error(`state hash mismatch (recorded ${String(parsed.hash)}, actual ${hash})`);
    return { version: parsed.version as number, value, hash, ...(parsed.requestId !== undefined ? { requestId: parsed.requestId as string } : {}) };
  } catch (error) {
    throw new Error(`corrupt state file ${file} — ${error instanceof Error ? error.message : String(error)}`);
  }
}

function emptyState(): LedgerStateSnapshot {
  const value: Record<string, JsonValue> = {};
  return { expectedVersion: 0, version: 0, value, hash: hashJsonObject(value), requestId: "" };
}

function ledgerSnapshot(snapshot: StateFileSnapshot): LedgerStateSnapshot {
  return {
    expectedVersion: Math.max(0, snapshot.version - 1),
    version: snapshot.version,
    value: snapshot.value,
    hash: snapshot.hash,
    requestId: snapshot.requestId ?? ""
  };
}

function sameSnapshot(a: StateFileSnapshot | LedgerStateSnapshot, b: LedgerStateSnapshot): boolean {
  return a.version === b.version && a.hash === b.hash;
}

function deriveState(root: string, records: SessionTransactionRecord[]): LedgerStateSnapshot {
  const cached = existsSync(statePath(root)) ? readStateFile(statePath(root)) : undefined;
  const states = records.filter((record) => record.state !== undefined).sort((a, b) => a.state!.version - b.state!.version);
  if (states.length === 0) {
    if (cached === undefined) return emptyState();
    return ledgerSnapshot(cached);
  }
  const first = states[0]!.state!;
  let current: LedgerStateSnapshot;
  if (first.expectedVersion === 0) current = emptyState();
  else if (existsSync(historyPath(root, first.expectedVersion))) {
    const base = readStateFile(historyPath(root, first.expectedVersion));
    if (base.version !== first.expectedVersion) throw new Error(`state history version mismatch: requested ${first.expectedVersion}, found ${base.version}`);
    current = ledgerSnapshot(base);
  }
  else if (cached !== undefined && cached.version === first.expectedVersion) {
    current = ledgerSnapshot(cached);
  } else {
    // A legacy session may already have a derived head newer than the first
    // ledger record. The record carries the complete next state, so the
    // missing legacy base does not prevent deriving the authoritative head.
    // Historical reads still fail if that base snapshot is requested later.
    current = {
      expectedVersion: Math.max(0, first.expectedVersion - 1),
      version: first.expectedVersion,
      value: {},
      hash: hashJsonObject({}),
      requestId: ""
    };
  }
  for (const record of states) {
    const state = record.state!;
    if (state.expectedVersion !== current.version || state.requestId !== record.requestId) {
      throw new Error(`state ledger version/owner mismatch for request ${record.requestId}`);
    }
    const historical = historyPath(root, state.version);
    if (existsSync(historical)) {
      const snapshot = readStateFile(historical);
      if (snapshot.version !== state.version || !sameSnapshot(snapshot, state) || (snapshot.requestId !== undefined && snapshot.requestId !== state.requestId)) {
        throw new Error(`state history version ${state.version} does not match the authoritative session ledger`);
      }
    }
    current = state;
  }
  if (cached !== undefined) {
    if (cached.version > current.version) throw new Error(`state snapshot version ${cached.version} is ahead of session ledger version ${current.version}`);
    if (cached.version === current.version && (!sameSnapshot(cached, current) || (cached.requestId !== undefined && cached.requestId !== current.requestId))) {
      throw new Error("derived state snapshot does not match the authoritative session ledger");
    }
  }
  return current;
}

/** @internal Read and validate one immutable ledger view for admission recovery. */
export function readSessionLedgerSnapshot(root: string): {
  records: SessionTransactionRecord[];
  state: LedgerStateSnapshot;
} {
  const records = readRecords(root);
  return { records, state: deriveState(root, records) };
}

function projectState(root: string, state: LedgerStateSnapshot): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(join(root, HISTORY_DIRECTORY), { recursive: true, mode: 0o700 });
  const value = { version: state.version, value: state.value, hash: state.hash, ...(state.requestId ? { requestId: state.requestId } : {}) };
  const history = historyPath(root, state.version);
  if (state.version > 0 && !existsSync(history)) writeAtomic(history, `${encode(value, "state snapshot")}\n`);
  if (state.version > 0 && existsSync(history)) {
    const prior = readStateFile(history);
    if (!sameSnapshot(prior, state)) throw new Error(`state history version ${state.version} already contains a different snapshot`);
  }
  writeAtomic(statePath(root), `${encode(value, "state snapshot")}\n`);
}

export function createSessionLedger(root: string): SessionLedger {
  function read(requestId: string): SessionTransactionRecord | undefined {
    return readRecord(root, requestId);
  }

  function list(): SessionTransactionRecord[] {
    return readRecords(root);
  }

  function readState(): LedgerStateSnapshot {
    return deriveState(root, list());
  }

  function readStateVersion(version: number): LedgerStateSnapshot {
    assertVersion(version, "state version");
    const records = list();
    const record = records.find((item) => item.state?.version === version);
    if (record?.state !== undefined) {
      deriveState(root, records);
      return record.state;
    }
    const current = deriveState(root, records);
    if (version === 0 && current.version === 0) return current;
    const legacy = historyPath(root, version);
    if (existsSync(legacy)) {
      const snapshot = readStateFile(legacy);
      if (snapshot.version !== version) throw new Error(`state history version mismatch: requested ${version}, found ${snapshot.version}`);
      return ledgerSnapshot(snapshot);
    }
    throw new Error(`missing committed state history version ${version}`);
  }

  function commit(input: SessionTransactionInput): SessionTransactionRecord {
    const next = canonical(input);
    const existing = read(next.requestId);
    if (existing !== undefined) {
      if (existing.recordHash === next.recordHash) return existing;
      throw new Error(`request transaction conflict for ${next.requestId}`);
    }
    if (next.state !== undefined) {
      const current = readState();
      if (current.version !== next.state.expectedVersion) {
        throw new Error(`state version conflict: expected ${next.state.expectedVersion}, found ${current.version}`);
      }
    }
    // Validate an existing state.json before the authoritative record is
    // installed. A broken cache cannot be silently healed by a new commit.
    if (next.state === undefined) readState();
    mkdirSync(transactionsDir(root), { recursive: true, mode: 0o700 });
    const file = transactionPath(root, next.requestId);
    try { installImmutable(file, `${encode(next, "session transaction")}\n`); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" && !(error instanceof Error && error.message === "record already exists")) throw error;
    }
    const installed = read(next.requestId);
    if (installed === undefined) throw new Error(`session transaction ${next.requestId} was not installed`);
    if (installed.recordHash !== next.recordHash) throw new Error(`request transaction conflict for ${next.requestId}`);
    if (installed.state !== undefined) {
      // The record is authoritative. A derived snapshot failure after this
      // point must not turn a durable result into stateCommitted:false.
      try { projectState(root, installed.state); } catch { /* recover from record on the next read */ }
    }
    return installed;
  }

  return {
    read,
    list,
    commit,
    readState,
    readStateVersion,
    verify(requestId, requestHash) {
      try {
        const record = read(requestId);
        if (record === undefined || (requestHash !== undefined && record.requestHash !== requestHash)) {
          return false;
        }
        if (record.state !== undefined) {
          const current = readState();
          if (current.version < record.state.version || readStateVersion(record.state.version).hash !== record.state.hash) {
            return false;
          }
        }
        return true;
      } catch { return false; }
    },
    commitState(requestId, requestHash, expectedVersion, state, result) {
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
        throw new Error("expectedVersion must be a non-negative safe integer");
      }
      if (typeof state !== "object" || state === null || Array.isArray(state)) {
        throw new Error("exec state must be a plain JSON object");
      }
      validateJsonValue(state, EXEC_MAX_STATE_BYTES);
      const hash = hashJsonObject(state);
      const version = expectedVersion + 1;
      const committedResult: ExecResult = { ...result, stateVersion: version, stateCommitted: true, stateHash: hash };
      const record = commit({
        schemaVersion: SESSION_LEDGER_SCHEMA_VERSION,
        requestId,
        requestHash,
        status: result.status,
        result: committedResult,
        ...(result.error !== undefined ? { error: result.error } : {}),
        state: { expectedVersion, version, value: state, hash, requestId }
      });
      return {
        result: (record.result ?? committedResult) as ExecResult,
        version: record.state?.version ?? version,
        hash: record.state?.hash ?? hash,
        record
      };
    }
  };
}

export function commitSessionState(
  root: string,
  requestId: string,
  requestHash: string,
  expectedVersion: number,
  state: Record<string, JsonValue>,
  result: ExecResult
): LedgerStateCommit {
  return createSessionLedger(root).commitState(requestId, requestHash, expectedVersion, state, result);
}

export function loadLedgerState(root: string): LedgerStateSnapshot | undefined {
  if (!existsSync(transactionsDir(root))) return undefined;
  return deriveState(root, readRecords(root));
}

export function loadLedgerStateVersion(root: string, version: number): LedgerStateSnapshot | undefined {
  if (!existsSync(transactionsDir(root))) return undefined;
  const records = readRecords(root);
  const record = records.find((item) => item.state?.version === version);
  if (record?.state !== undefined) {
    deriveState(root, records);
    return record.state;
  }
  const current = deriveState(root, records);
  return version === 0 && current.version === 0 ? current : undefined;
}
