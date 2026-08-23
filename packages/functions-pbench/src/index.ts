import type { FunctionCommand } from "@ya-skills/core";
import { homedir } from "node:os";
import { join } from "node:path";
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
import type { ValidationResult } from "./authoring.js";
import { createPbenchReport, renderPbenchReportMarkdown } from "./reporting.js";
import { createReplay } from "./replay.js";

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

type ParsedArgs = { options: Record<string, string | boolean>; positionals: string[] };
type PbenchCommandOptions = { home?: string };

const REPLAY = createReplay({
  validateCaseBundle: (caseDir) => validateCaseBundle(caseDir, { strict: false })
});

function normalizeRunProfile(value: string | undefined): string {
  return value?.trim() || "default";
}

export function createPbenchCommands(options: PbenchCommandOptions = {}): FunctionCommand[] {
  return [
    {
      domain: "pbench",
      action: "capture",
      description: "Create a persistent pbench authoring transaction from a coding-agent session.",
      run: async (args) => {
        const parsed = parseArgs(args);
        const source = getString(parsed, "source") ?? "codex";
        const workspace = getString(parsed, "workspace");
        const yes = getBoolean(parsed, "yes");
        const workspaceRoot = workspace
          ? await resolveWorkspaceRoot({ workspace, cwd: process.cwd(), home: options.home, createDefault: yes })
          : await resolveWorkspaceRoot({ cwd: process.cwd(), home: options.home, createDefault: yes });
        const result = await captureSession({
          cwd: process.cwd(),
          workspaceRoot,
          input: getString(parsed, "input"),
          sessionId: getString(parsed, "session-id"),
          source,
          yes,
          title: getString(parsed, "title"),
          home: options.home
        });
        const initialValidation = await validateAuthoringDraft(result.caseDir);
        return printJson({
          ...result,
          initialValidation,
          state: initialValidation.ok ? "ready-to-finalize" : "needs-authoring",
          nextAction: initialValidation.ok
            ? `yk pbench finalize --transaction ${result.transactionPath}`
            : `Read ${result.authoringChecklistPath}`,
          next: [
            `Review ${result.caseDir}`,
            `yk pbench validate --transaction ${result.transactionPath} --strict`,
            `yk pbench finalize --transaction ${result.transactionPath}`
          ]
        });
      }
    },
    {
      domain: "pbench",
      action: "validate",
      description: "Validate a pbench transaction or case bundle.",
      run: async (args) => {
        const parsed = parseArgs(args);
        const transaction = getString(parsed, "transaction");
        const caseDir = getString(parsed, "case");
        let result: ValidationResult;
        if (transaction) {
          result = getBoolean(parsed, "strict")
            ? await strictValidateTransaction(transaction)
            : await validateCaseBundle(join(absolutePath(transaction), "case"), { strict: false });
        } else if (caseDir) {
          result = await validateCaseBundle(caseDir, {
            strict: getBoolean(parsed, "strict"),
            workspaceRoot: getString(parsed, "workspace")
          });
        } else {
          throw new Error("Pass --transaction <path> or --case <path>.");
        }
        return printJson(result);
      }
    },
    {
      domain: "pbench",
      action: "export-replay",
      description: "Export a public-only pbench replay capsule for an agent.",
      run: async (args) => {
        const parsed = parseArgs(args);
        const caseInput = requireString(parsed, "case", "yk pbench export-replay requires --case <case-dir-or-case-id>");
        const out = requireString(parsed, "out", "yk pbench export-replay requires --out <dir>");
        const caseDir = await resolveCaseDirInput({
          caseInput,
          cwd: process.cwd(),
          home: options.home,
          workspace: getString(parsed, "workspace")
        });
        return printJson(
          await exportReplayCapsule({
            caseDir,
            outDir: absolutePath(out, process.cwd(), options.home ?? homedir()),
            force: getBoolean(parsed, "force")
          })
        );
      }
    },
    {
      domain: "pbench",
      action: "run",
      description: "Run a pbench case through a harness-managed agent and private validator.",
      run: async (args) => {
        const parsed = parseArgs(args);
        const caseInput = requireString(parsed, "case", "yk pbench run requires --case <case-dir-or-case-id>");
        const manual = getBoolean(parsed, "manual");
        const requestedAgent = getString(parsed, "agent");
        if (manual && requestedAgent) {
          throw new Error("yk pbench run --manual and --agent cannot be used together.");
        }
        const workspaceRoot = await resolveWorkspaceRoot({
          workspace: getString(parsed, "workspace"),
          cwd: process.cwd(),
          home: options.home
        });
        const caseDir = await resolveCaseDirInput({
          caseInput,
          cwd: process.cwd(),
          home: options.home,
          workspace: workspaceRoot
        });
        const profile = normalizeRunProfile(getString(parsed, "profile"));
        if (manual) {
          return printJson(
            await REPLAY.startManualRun({
              caseDir,
              workspaceRoot,
              home: options.home,
              profile,
              contaminated: getBoolean(parsed, "contaminated")
            })
          );
        }
        return printJson(
          await REPLAY.runCase({
            caseDir,
            workspaceRoot,
            home: options.home,
            agent: requestedAgent ?? "codex",
            profile
          })
        );
      }
    },
    {
      domain: "pbench",
      action: "start",
      description: "Prepare a pbench case for a skill-mediated benchmark run.",
      run: async (args) => {
        const parsed = parseArgs(args);
        const caseInput = requireString(parsed, "case", "yk pbench start requires --case <case-dir-or-case-id>");
        const workspaceRoot = await resolveWorkspaceRoot({
          workspace: getString(parsed, "workspace"),
          cwd: process.cwd(),
          home: options.home
        });
        const caseDir = await resolveCaseDirInput({
          caseInput,
          cwd: process.cwd(),
          home: options.home,
          workspace: workspaceRoot
        });
        return printJson(
          await REPLAY.startManualRun({
            caseDir,
            workspaceRoot,
            home: options.home,
            profile: normalizeRunProfile(getString(parsed, "profile")),
            contaminated: getBoolean(parsed, "contaminated")
          })
        );
      }
    },
    {
      domain: "pbench",
      action: "finish",
      description: "Finish a skill-mediated pbench run with private validation.",
      run: async (args) => {
        const parsed = parseArgs(args);
        const runId = requireString(parsed, "run", "yk pbench finish requires --run <run-id>");
        return printJson(await REPLAY.finishRun({ runId, home: options.home }));
      }
    },
    {
      domain: "pbench",
      action: "finalize",
      description: "Finalize a strict-validated pbench transaction.",
      run: async (args) => {
        const parsed = parseArgs(args);
        const transaction = requireString(parsed, "transaction", "yk pbench finalize requires --transaction <path>");
        return printJson(await finalizeTransaction(transaction));
      }
    },
    {
      domain: "pbench",
      action: "report",
      description: "Aggregate pbench run artifacts into a benchmark report.",
      run: async (args) => {
        const parsed = parseArgs(args);
        const workspaceRoot = await resolveWorkspaceRoot({
          workspace: getString(parsed, "workspace"),
          cwd: process.cwd(),
          home: options.home
        });
        const report = await createPbenchReport({
          workspaceRoot,
          caseFilter: await resolveReportCaseFilter({
            caseInput: getString(parsed, "case"),
            cwd: process.cwd(),
            home: options.home
          }),
          profileFilter: getString(parsed, "profile") ? normalizeRunProfile(getString(parsed, "profile")) : undefined,
          includeUntrusted: getBoolean(parsed, "include-untrusted")
        });
        const format = getString(parsed, "format") ?? "markdown";
        if (format === "markdown") {
          return renderPbenchReportMarkdown(report);
        }
        if (format !== "json") {
          throw new Error(`Unsupported pbench report format: ${format}`);
        }
        return printJson(report);
      }
    },
    {
      domain: "pbench",
      action: "audit",
      description: "Audit pbench case quality without running private validators.",
      run: async (args) => {
        const parsed = parseArgs(args);
        const caseInput = getString(parsed, "case");
        if (caseInput) {
          const caseDir = await resolveCaseDirInput({
            caseInput,
            cwd: process.cwd(),
            home: options.home,
            workspace: getString(parsed, "workspace")
          });
          return printJson(await auditPbenchCase(caseDir));
        }
        const workspaceRoot = await resolveWorkspaceRoot({
          workspace: getString(parsed, "workspace"),
          cwd: process.cwd(),
          home: options.home
        });
        return printJson(await auditPbenchWorkspace(workspaceRoot));
      }
    },
    {
      domain: "pbench",
      action: "workspace-init",
      description: "Initialize a pbench workspace.",
      run: async (args) => {
        const parsed = parseArgs(args);
        const path = parsed.positionals[0];
        if (!path) {
          throw new Error("yk pbench workspace-init requires <path>");
        }
        return printJson(await initWorkspace(path));
      }
    },
    {
      domain: "pbench",
      action: "project-link",
      description: "Link the current project to a pbench workspace.",
      run: async (args) => {
        const parsed = parseArgs(args);
        const workspace = requireString(parsed, "workspace", "yk pbench project-link requires --workspace <path>");
        return printJson({ linkPath: await linkProject(process.cwd(), workspace) });
      }
    }
  ];
}

function parseArgs(args: string[]): ParsedArgs {
  const options: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index += 1;
  }
  return { options, positionals };
}

function getString(parsed: ParsedArgs, key: string): string | undefined {
  const value = parsed.options[key];
  return typeof value === "string" ? value : undefined;
}

function requireString(parsed: ParsedArgs, key: string, message: string): string {
  const value = getString(parsed, key);
  if (!value) {
    throw new Error(message);
  }
  return value;
}

function getBoolean(parsed: ParsedArgs, key: string): boolean {
  return parsed.options[key] === true;
}

function printJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
