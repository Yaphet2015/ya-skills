export { createComputerUseCommands, clickPredicate, normalizeText } from "./commands.js";
export {
  parseRequest,
  USAGE,
  type ParsedRequest,
  type ActSpec,
  type ClickSpec,
  type ScrollSpec,
  type ScrollDirection
} from "./args.js";
export { COMMAND_DEADLINE_MS, CLEANUP_DEADLINE_MS, runDoctor, type DoctorDeps, type DoctorReport, type PlatformInfo } from "./runtime.js";
// Desktop primitives live in @ya-skills/computer-runtime now; these
// re-exports keep the historical import surface of this package working.
export {
  bigintSafeReplacer,
  compiledSdkUrl,
  ensureOutDir,
  isCompiledRuntime,
  isSupportedPlatform,
  loadSdk,
  sanitizeElements,
  saveScreenshot,
  selectWindow,
  defaultArtifactsDir,
  type AxElement,
  type WindowRef
} from "@ya-skills/computer-runtime";
