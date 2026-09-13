// Private workspace surface for the two internal entrypoints (computer-use
// CLI and the e2e worker). Never published to npm, never imported by skills
// or consumer projects.

export type {
  AppRef,
  AxElement,
  Backend,
  BackendFactory,
  Computer,
  Predicate,
  ScrollDirection,
  ScrollSpec,
  Snapshot,
  Target,
  ToolResultLike,
  WindowRef
} from "./types.js";

export { ComputerError, CLEANUP_BUDGET_MS, OP_LIMIT_MS } from "./session.js";
export type { ComputerSession, SessionOptions } from "./session.js";
export { createComputerSession } from "./cua-backend.js";
export { createSessionWithBackend } from "./session.js";

export { clickUnique, waitForElements, DEFAULT_INTERVAL_MS, DEFAULT_TIMEOUT_MS } from "./actions.js";
export {
  bigintSafeReplacer,
  normalizeElements,
  sanitizeElements,
  selectWindow
} from "./observe.js";
export { artifactPath, defaultArtifactsDir, ensureOutDir, saveScreenshot } from "./artifacts.js";
export { compiledSdkUrl, isCompiledRuntime, isSupportedPlatform, loadSdk } from "./sdk.js";
