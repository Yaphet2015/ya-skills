import { loadExecState, loadExecStateVersion } from "./exec-state.js";
import type { RequestJournal } from "@ya-skills/computer-runtime";
import {
  createSessionLedger,
  readSessionLedgerSnapshot,
  type LedgerStateSnapshot,
  type SessionLedger,
  type SessionTransactionRecord
} from "./session-ledger.js";

export type StateCommitDisposition = "committed" | "abandoned" | "uncertain";

export function classifyExecStateCommit(result: unknown): StateCommitDisposition {
  if (typeof result !== "object" || result === null) return "uncertain";
  const value = result as {
    status?: unknown;
    stateCommitted?: unknown;
    error?: { code?: unknown };
  };
  if (value.stateCommitted === true) return "committed";
  if (value.status === "interrupted" && value.error?.code === "request_cancelled") return "abandoned";
  return "uncertain";
}

export interface ExecStateRecovery {
  /** The authoritative terminal-result/state store for the session. */
  ledger: SessionLedger;
  validateLedgerTransaction(requestId: string, expectedRequestHash?: string): boolean;
  validateRecoveredExecState(
    record: Awaited<ReturnType<RequestJournal["read"]>>,
    expectedRequestId?: string
  ): boolean;
  validateStateBeforeAdmission(): Promise<void>;
}

/** Keep crash recovery rules together with the state files they validate. */
export function createExecStateRecovery(
  stateDir: string,
  journal: RequestJournal,
  activeRequestId: () => string | undefined
): ExecStateRecovery {
  const ledger = createSessionLedger(stateDir);

  const validateLegacyRecoveredExecState = (
    record: Awaited<ReturnType<RequestJournal["read"]>>,
    expectedRequestId?: string
  ): boolean => {
    const value = record.result as {
      status?: unknown;
      stateCommitted?: unknown;
      stateVersion?: unknown;
      stateHash?: unknown;
      error?: { code?: unknown };
    } | undefined;
    const intent = record.events.find((event) => event.type === "state_commit_intent");
    if (intent === undefined) return value?.stateCommitted !== true;
    const payload = intent.payload;
    if (
      typeof payload.requestId !== "string" ||
      payload.requestId.length === 0 ||
      (expectedRequestId !== undefined && payload.requestId !== expectedRequestId) ||
      typeof payload.expectedVersion !== "number" ||
      !Number.isSafeInteger(payload.expectedVersion) ||
      typeof payload.version !== "number" ||
      !Number.isSafeInteger(payload.version) ||
      payload.version !== payload.expectedVersion + 1 ||
      typeof payload.stateHash !== "string"
    ) return false;

    const finished = [...record.events].reverse().find((event) => event.type === "request_finished");
    const disposition = finished?.payload.stateCommitDisposition;
    if (disposition !== undefined && disposition !== "committed" && disposition !== "abandoned" && disposition !== "uncertain") {
      return false;
    }
    const terminalProvesAbandoned =
      finished?.payload.status === "interrupted" &&
      value?.status === "interrupted" &&
      value.stateCommitted === false &&
      value.error?.code === "request_cancelled";
    // Only a durable cancellation after the intent proves abandonment; a
    // timeout or a failed commit still requires matching state history.
    const explicitlyAbandoned = terminalProvesAbandoned && (disposition === undefined || disposition === "abandoned");
    if (disposition === "abandoned" && !explicitlyAbandoned) return false;
    if (disposition === "committed" && value?.stateCommitted !== true) return false;

    try {
      const current = loadExecState(stateDir);
      if (explicitlyAbandoned) {
        if (current.version < payload.expectedVersion) return false;
        try {
          const snapshot = loadExecStateVersion(stateDir, payload.version);
          // History without an advanced head is an orphaned partial commit.
          if (current.version === payload.expectedVersion) return false;
          return snapshot.requestId !== undefined && snapshot.requestId !== payload.requestId;
        } catch (error) {
          return current.version === payload.expectedVersion && isMissingStateHistory(error);
        }
      }
      if (current.version < payload.version) return false;
      const snapshot = loadExecStateVersion(stateDir, payload.version);
      // Equal content alone cannot prove which request committed this version.
      if (snapshot.requestId !== payload.requestId || snapshot.hash !== payload.stateHash) return false;
      if (value?.stateCommitted === true) {
        return finished !== undefined &&
          typeof value.stateVersion === "number" &&
          value.stateVersion === payload.version &&
          typeof value.stateHash === "string" &&
          value.stateHash === payload.stateHash;
      }
      return true;
    } catch {
      return false;
    }
  };

  const validateLedgerTransaction = (requestId: string, expectedRequestHash?: string): boolean => {
    try {
      const transaction = ledger.read(requestId);
      if (transaction === undefined) return false;
      if (expectedRequestHash !== undefined && transaction.requestHash !== expectedRequestHash) return false;
      if (!ledger.verify(requestId, expectedRequestHash)) return false;
      const result = transaction.result as {
        stateCommitted?: unknown;
        stateVersion?: unknown;
        stateHash?: unknown;
      } | undefined;
      if (transaction.state === undefined) return result?.stateCommitted !== true;
      return result?.stateCommitted === true &&
        result.stateVersion === transaction.state.version &&
        result.stateHash === transaction.state.hash;
    } catch {
      return false;
    }
  };

  const validateRecoveredExecState = (
    record: Awaited<ReturnType<RequestJournal["read"]>>,
    expectedRequestId?: string
  ): boolean => {
    if (expectedRequestId !== undefined) {
      let authoritative: ReturnType<SessionLedger["read"]>;
      try {
        authoritative = ledger.read(expectedRequestId);
      } catch {
        return false;
      }
      if (authoritative !== undefined) {
        return validateLedgerTransaction(expectedRequestId, record.hash);
      }
    }
    return validateLegacyRecoveredExecState(record, expectedRequestId);
  };

  function validateAdmissionTransaction(
    transaction: SessionTransactionRecord,
    state: LedgerStateSnapshot,
    recordsByRequestId: ReadonlyMap<string, SessionTransactionRecord>,
    recordsByStateVersion: ReadonlyMap<number, SessionTransactionRecord>,
    expectedRequestHash?: string
  ): boolean {
    if (recordsByRequestId.get(transaction.requestId) !== transaction) return false;
    if (expectedRequestHash !== undefined && transaction.requestHash !== expectedRequestHash) return false;
    if (transaction.state === undefined) {
      const result = transaction.result as { stateCommitted?: unknown } | undefined;
      return result?.stateCommitted !== true;
    }
    const stateRecord = recordsByStateVersion.get(transaction.state.version);
    if (stateRecord !== transaction || state.version < transaction.state.version) return false;
    const result = transaction.result as {
      stateCommitted?: unknown;
      stateVersion?: unknown;
      stateHash?: unknown;
    } | undefined;
    return result?.stateCommitted === true &&
      result.stateVersion === transaction.state.version &&
      result.stateHash === transaction.state.hash;
  }

  return {
    ledger,
    validateLedgerTransaction,
    validateRecoveredExecState,
    async validateStateBeforeAdmission() {
      // Parse the immutable ledger records once and derive the state chain
      // once for this admission. Per-record verify() would rescan the whole
      // ledger and its history for every transaction.
      const snapshot = readSessionLedgerSnapshot(stateDir);
      const transactions = snapshot.records;
      const state = snapshot.state;
      const recordsByRequestId = new Map<string, SessionTransactionRecord>();
      const recordsByStateVersion = new Map<number, SessionTransactionRecord>();
      for (const transaction of transactions) {
        recordsByRequestId.set(transaction.requestId, transaction);
        if (transaction.state !== undefined) {
          recordsByStateVersion.set(transaction.state.version, transaction);
        }
      }
      for (const transaction of transactions) {
        if (!validateAdmissionTransaction(transaction, state, recordsByRequestId, recordsByStateVersion, transaction.requestHash)) {
          throw new Error(`request ${transaction.requestId} has an unverifiable session transaction`);
        }
      }
      for (const requestId of await journal.list()) {
        const record = await journal.read(requestId);
        const authoritative = recordsByRequestId.get(requestId);
        if (authoritative !== undefined) {
          // A committed ledger record proves terminal ownership even when a
          // crash removed or interrupted the legacy request_finished
          // projection. The journal hash still binds the proof to this exact
          // request content.
          if (!validateAdmissionTransaction(authoritative, state, recordsByRequestId, recordsByStateVersion, record.hash)) {
            throw new Error(`request ${requestId} has an unverifiable session transaction`);
          }
          continue;
        }
        if (record.status === "running" && requestId !== activeRequestId()) {
          throw new Error(`request ${requestId} is still running; recovery ownership is not proven`);
        }
        if (record.events.some((event) => event.type === "state_commit_intent") && !validateLegacyRecoveredExecState(record, requestId)) {
          throw new Error(`request ${requestId} has an unverifiable state commit history`);
        }
      }
    }
  };
}

function isMissingStateHistory(error: unknown): boolean {
  return error instanceof Error && /missing committed state history version/.test(error.message);
}
