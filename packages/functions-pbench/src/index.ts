import type { FunctionCommand } from "@ya-skills/core";
import {
  absolutePath,
  auditPbenchCase,
  auditPbenchWorkspace,
  captureSession,
  exportReplayCapsule,
  finalizeTransaction,
  initWorkspace,
  linkProject,
  resolveCaseDirInput,
  resolveReportCaseFilter,
  resolveWorkspaceRoot,
  strictValidateTransaction,
  validateAuthoringDraft,
  validateCaseBundle
} from "./authoring.js";
import { createCommands, type PbenchCommandDependencies, type PbenchCommandOptions } from "./commands.js";
import { createPbenchReport, renderPbenchReportMarkdown } from "./reporting.js";
import { createReplay } from "./replay.js";

const replay = createReplay({
  validateCaseBundle: (caseDir) => validateCaseBundle(caseDir, { strict: false })
});

const commandDependencies: PbenchCommandDependencies = {
  absolutePath,
  auditPbenchCase,
  auditPbenchWorkspace,
  captureSession,
  exportReplayCapsule,
  finalizeTransaction,
  initWorkspace,
  linkProject,
  resolveCaseDirInput,
  resolveReportCaseFilter,
  resolveWorkspaceRoot,
  strictValidateTransaction,
  validateAuthoringDraft,
  validateCaseBundle,
  replay,
  createPbenchReport,
  renderPbenchReportMarkdown
};

export function createPbenchCommands(options: PbenchCommandOptions = {}): FunctionCommand[] {
  return createCommands(commandDependencies, options);
}

export {
  captureCodexSession,
  captureSession,
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
