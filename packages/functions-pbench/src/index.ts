import type { FunctionCommand } from "@ya-skills/core";
import type { SessionSource } from "./adapters/types.js";
import { createCodexSessionSource } from "./adapters/codex.js";
import { createClaudeSessionSource } from "./adapters/claude.js";
import { createAuthoring } from "./authoring.js";
import { createCommands, type PbenchCommandOptions } from "./commands.js";
import { createHarborWorkflow } from "./harbor-workflow.js";
import { indexById } from "./registry.js";

const authoring = createAuthoring({ sessionSources: indexById<SessionSource>([
  createCodexSessionSource(), createClaudeSessionSource()
]) });

export const captureSession = authoring.captureSession;
export const captureCodexSession = captureSession;
const workflow = createHarborWorkflow({ captureSession });

export function createPbenchCommands(options: PbenchCommandOptions = {}): FunctionCommand[] {
  return createCommands(workflow, options);
}

export {
  finalizeTransaction,
  initWorkspace,
  linkProject,
  makeCaseId,
  resolveGitRoot,
  resolveWorkspaceRoot,
  slugify,
  strictValidateTransaction,
  validateCaseBundle
} from "./authoring.js";
export type { CaptureOptions, CapturePlan, CaptureResult, ValidationResult, WorkspaceInfo } from "./authoring.js";
export type { ValidatorOutcome } from "./run-types.js";
