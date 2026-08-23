import type { FunctionCommand } from "@ya-skills/core";
import runnerSkillMarkdown from "../assets/pbench-runner/SKILL.md" with { type: "text" };
import { createCodexAgentRunner, createCodexSessionSource } from "./adapters/codex.js";
import { createClaudeAgentRunner, createClaudeSessionSource } from "./adapters/claude.js";
import type { AgentRunner, SessionSource } from "./adapters/types.js";
import {
  absolutePath,
  createAuthoring,
  exportReplayCapsule,
  finalizeTransaction,
  findAuthoringWarnings,
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
import { createPbenchAudit, createPbenchReport, renderPbenchReportMarkdown } from "./reporting.js";
import { indexById } from "./registry.js";
import { createReplay } from "./replay.js";

const sessionSources = indexById<SessionSource>([
  createCodexSessionSource(),
  createClaudeSessionSource()
]);
const agentRunners = indexById<AgentRunner>([
  createCodexAgentRunner(),
  createClaudeAgentRunner()
]);
const authoring = createAuthoring({ sessionSources });
const replay = createReplay({
  validateCaseBundle: (caseDir) => validateCaseBundle(caseDir, { strict: false }),
  agentRunners,
  runnerSkillMarkdown
});
const audit = createPbenchAudit({
  validateCaseBundle: (caseDir) => validateCaseBundle(caseDir, { strict: false }),
  findAuthoringWarnings
});

export const captureSession = authoring.captureSession;
export const captureCodexSession = captureSession;

const commandDependencies: PbenchCommandDependencies = {
  absolutePath,
  auditPbenchCase: audit.auditCase,
  auditPbenchWorkspace: audit.auditWorkspace,
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
