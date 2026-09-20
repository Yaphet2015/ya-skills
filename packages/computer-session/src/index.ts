// Public surface of the session package. Worker/host internal entrypoints
// stay internal (hostMain/driverWorkerMain are exported for the CLI's
// dedicated internal routes only).

export type {
  SessionControl,
  SessionControlReply,
  SessionInfo,
  SessionOperation,
  SessionReply,
  SessionRequest,
  SessionState
} from "./types.js";
export {
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  FrameReader,
  ProtocolError,
  decodeReply,
  decodeAxValueResult,
  decodeSessionReply,
  decodeRequest,
  encodeControl,
  encodeRequest
} from "./protocol.js";
export { assertSocketPathLength, sessionPaths, sessionRoot, socketRoot, validateSessionId } from "./paths.js";
export { sendControl, sendRequest } from "./client.js";
export { hostMain, startHost, DEFAULT_IDLE_TIMEOUT_MS, MAX_IDLE_TIMEOUT_MS, type Host, type HostConfig, type HostDeps } from "./host.js";
export { driverWorkerMain, buildDriverSession, type DriverConfig, type DriverSessionLike } from "./driver-worker.js";
export { internalSpawnCommand, spawnInternalWorker, stopProcessGroup, TERM_GRACE_MS, type SpawnCommand, type StopResult } from "./process.js";
export {
  closeOwnedFd,
  createWorkerWatchdog,
  FileSpoolReader,
  spawnWorker,
  spawnWorkerWithRetry,
  type InternalEntrypoint,
  type SpoolPoll,
  type SpoolTail,
  type WorkerSpawnOptions,
  type WorkerWatchdog
} from "./worker-lifecycle.js";
export { findSession, openSession, type OpenedSession, type OpenSessionOptions } from "./open.js";
export {
  EXEC_DEFAULT_MAX_ACTIONS,
  EXEC_DEFAULT_TIMEOUT_MS,
  EXEC_MAX_ACTIONS_LIMIT,
  EXEC_MAX_CODE_BYTES,
  EXEC_MAX_LOG_BYTES,
  EXEC_MAX_OBSERVATIONS,
  EXEC_MAX_STATE_BYTES,
  EXEC_MAX_TIMEOUT_MS,
  SCRIPT_METHODS,
  type ExecOptions,
  type ExecResult,
  type JsonValue,
  type ScriptComputer,
  type ScriptRpcMethod
} from "./exec-types.js";
export { createScriptComputer } from "./script-computer.js";
export { commitExecState, execStateHash, loadExecState, loadExecStateVersion, validateJsonValue } from "./exec-state.js";
export {
  commitSessionState,
  createSessionLedger,
  loadLedgerState,
  loadLedgerStateVersion,
  hashJsonObject,
  SESSION_LEDGER_DIRECTORY,
  SESSION_LEDGER_SCHEMA_VERSION,
  type LedgerRequestError,
  type LedgerRequestStatus,
  type LedgerStateCommit,
  type LedgerStateSnapshot,
  type SessionLedger,
  type SessionTransactionInput,
  type SessionTransactionRecord
} from "./session-ledger.js";
export { execWorkerMain, type ExecWorkerConfig } from "./exec-worker.js";
export { normalizeExecOptions, runExec } from "./exec-runner.js";
