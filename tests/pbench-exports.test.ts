import { expect, test } from "bun:test";
import {
  captureCodexSession,
  captureSession,
  createPbenchCommands,
  finalizeTransaction,
  initWorkspace,
  linkProject,
  makeCaseId,
  resolveGitRoot,
  resolveWorkspaceRoot,
  slugify,
  strictValidateTransaction,
  validateCaseBundle
} from "@ya-skills/functions-pbench";

test("pbench keeps its public package interface stable", () => {
  for (const exported of [
    createPbenchCommands,
    slugify,
    makeCaseId,
    initWorkspace,
    linkProject,
    resolveWorkspaceRoot,
    resolveGitRoot,
    captureSession,
    validateCaseBundle,
    strictValidateTransaction,
    finalizeTransaction
  ]) {
    expect(exported).toBeFunction();
  }
  expect(captureCodexSession).toBe(captureSession);
});
