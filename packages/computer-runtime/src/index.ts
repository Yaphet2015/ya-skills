// Private workspace surface for the two internal entrypoints (computer-use
// CLI and the e2e worker). Never published to npm, never imported by skills
// or consumer projects.

export type {
  AppRef,
  AxChannel,
  AxElement,
  Backend,
  BackendFactory,
  BatchAction,
  BatchRequest,
  BatchResult,
  ActionReceipt,
  ChannelStatus,
  Computer,
  Condition,
  ImageChannel,
  ImageGeometry,
  NativeObservationLike,
  Observation,
  ObservationMode,
  ObserveCallOptions,
  ObserveOptions,
  Point,
  PointClick,
  Predicate,
  Rect,
  ScrollDirection,
  ScrollSpec,
  Selector,
  Snapshot,
  Target,
  ToolResultLike,
  WindowRef
} from "./types.js";

export { ComputerError, CLEANUP_BUDGET_MS, OBSERVATION_TTL_MS, OP_LIMIT_MS } from "./session.js";
export type { ComputerSession, SessionOptions, MutationLeases } from "./session.js";
export { createComputerSession } from "./cua-backend.js";
export { createSessionWithBackend, createAutoLeases } from "./session.js";

export { clickUnique, waitForElements, DEFAULT_INTERVAL_MS, DEFAULT_TIMEOUT_MS } from "./actions.js";
export {
  bigintSafeReplacer,
  normalizeElements,
  projectObservation,
  sanitizeElements,
  selectWindow,
  selectorMatches
} from "./observe.js";
export { artifactPath, defaultArtifactsDir, ensureOutDir, saveScreenshot } from "./artifacts.js";
export { compiledSdkUrl, isCompiledRuntime, isSupportedPlatform, loadSdk } from "./sdk.js";
export { mapImagePoint, mapImagePointToDriverPixels } from "./coordinates.js";
export {
  createObservationStore,
  frameMatchesObservation,
  pngSha256,
  resizeScreenshot,
  type ObservationStore,
  type ProcessRunner,
  type ResizeResult
} from "./observation-store.js";
export {
  DEFAULT_MAX_ACTIONS,
  MAX_ACTIONS_LIMIT,
  DEFAULT_BATCH_TIMEOUT_MS,
  MAX_BATCH_TIMEOUT_MS,
  runBatch,
  validateBatch
} from "./batch.js";
export { evaluateCondition, isUnsupportedCondition, UnsupportedConditionError } from "./conditions.js";
export {
  canonicalRequestHash,
  createRequestJournal,
  type RequestEvent,
  type RequestEventType,
  type RequestJournal,
  type RequestRecord,
  type RequestStatus
} from "./request-journal.js";
export {
  acquireTargetLease,
  inspectTargetLease,
  processStartTime,
  LeaseError,
  type LeaseHandle,
  type LeaseOwner
} from "./target-lease.js";
