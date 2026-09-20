import type { FunctionCommand } from "@ya-skills/core";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ValidationResult } from "./authoring.js";
import { normalizeRunProfile } from "./shared.js";

type AuthoringCommandDependencies = Pick<
  typeof import("./authoring.js"),
  | "absolutePath"
  | "exportReplayCapsule"
  | "finalizeTransaction"
  | "initWorkspace"
  | "linkProject"
  | "resolveCaseDirInput"
  | "resolveReportCaseFilter"
  | "resolveWorkspaceRoot"
  | "strictValidateTransaction"
  | "validateAuthoringDraft"
  | "validateCaseBundle"
>;

export type PbenchCommandDependencies = AuthoringCommandDependencies & {
  captureSession: ReturnType<typeof import("./authoring.js").createAuthoring>["captureSession"];
  auditPbenchCase: ReturnType<typeof import("./reporting.js").createPbenchAudit>["auditCase"];
  auditPbenchWorkspace: ReturnType<typeof import("./reporting.js").createPbenchAudit>["auditWorkspace"];
  replay: ReturnType<typeof import("./replay.js").createReplay>;
  createPbenchReport: typeof import("./reporting.js").createPbenchReport;
  renderPbenchReportMarkdown: typeof import("./reporting.js").renderPbenchReportMarkdown;
};

type ParsedArgs = { options: Record<string, string | boolean>; positionals: string[] };
export type PbenchCommandOptions = { home?: string };

export function createCommands(dependencies: PbenchCommandDependencies, options: PbenchCommandOptions = {}): FunctionCommand[] {
  return [
    {
      domain: "pbench",
      action: "capture",
      description: "Create a persistent pbench authoring transaction from a coding-agent session.",
      usage: [
        "yk pbench capture [--source codex|claude] [--input JSONL] [--session-id ID] [--title TITLE] [--workspace PATH] [--yes]"
      ],
      run: async (args) => {
        const parsed = parseArgs(args);
        const source = getString(parsed, "source") ?? "codex";
        const yes = getBoolean(parsed, "yes");
        const workspaceRoot = await resolveCommandWorkspace(dependencies, parsed, options, yes);
        const result = await dependencies.captureSession({
          cwd: process.cwd(),
          workspaceRoot,
          input: getString(parsed, "input"),
          sessionId: getString(parsed, "session-id"),
          source,
          yes,
          title: getString(parsed, "title"),
          home: options.home
        });
        const initialValidation = await dependencies.validateAuthoringDraft(result.caseDir);
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
      usage: ["yk pbench validate (--transaction PATH | --case PATH) [--strict] [--workspace PATH]"],
      run: async (args) => {
        const parsed = parseArgs(args);
        const transaction = getString(parsed, "transaction");
        const caseDir = getString(parsed, "case");
        let result: ValidationResult;
        if (transaction) {
          result = getBoolean(parsed, "strict")
            ? await dependencies.strictValidateTransaction(transaction)
            : await dependencies.validateCaseBundle(join(dependencies.absolutePath(transaction), "case"), { strict: false });
        } else if (caseDir) {
          result = await dependencies.validateCaseBundle(caseDir, {
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
      usage: ["yk pbench export-replay --case CASE --out DIR [--workspace PATH] [--force]"],
      run: async (args) => {
        const parsed = parseArgs(args);
        const caseInput = requireString(parsed, "case", "yk pbench export-replay requires --case <case-dir-or-case-id>");
        const out = requireString(parsed, "out", "yk pbench export-replay requires --out <dir>");
        const caseDir = await dependencies.resolveCaseDirInput({
          caseInput,
          cwd: process.cwd(),
          home: options.home,
          workspace: getString(parsed, "workspace")
        });
        return printJson(
          await dependencies.exportReplayCapsule({
            caseDir,
            outDir: dependencies.absolutePath(out, process.cwd(), options.home ?? homedir()),
            force: getBoolean(parsed, "force")
          })
        );
      }
    },
    {
      domain: "pbench",
      action: "run",
      description: "Run a pbench case through a harness-managed agent and private validator.",
      usage: [
        "yk pbench run --case CASE --agent AGENT [--workspace PATH] [--profile NAME]",
        "yk pbench run --case CASE --manual [--workspace PATH] [--profile NAME] [--contaminated]"
      ],
      run: async (args) => {
        const parsed = parseArgs(args);
        const caseInput = requireString(parsed, "case", "yk pbench run requires --case <case-dir-or-case-id>");
        const manual = getBoolean(parsed, "manual");
        const requestedAgent = getString(parsed, "agent");
        if (manual && requestedAgent) {
          throw new Error("yk pbench run --manual and --agent cannot be used together.");
        }
        const workspaceRoot = await resolveCommandWorkspace(dependencies, parsed, options);
        const caseDir = await resolveCommandCase(dependencies, options, caseInput, workspaceRoot);
        const profile = normalizeRunProfile(getString(parsed, "profile"));
        if (manual) {
          return printJson(
            await dependencies.replay.startManualRun({
              caseDir,
              workspaceRoot,
              home: options.home,
              profile,
              contaminated: getBoolean(parsed, "contaminated")
            })
          );
        }
        return printJson(
          await dependencies.replay.runCase({
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
      usage: ["yk pbench start --case CASE [--workspace PATH] [--profile NAME] [--contaminated]"],
      run: async (args) => {
        const parsed = parseArgs(args);
        const caseInput = requireString(parsed, "case", "yk pbench start requires --case <case-dir-or-case-id>");
        const workspaceRoot = await resolveCommandWorkspace(dependencies, parsed, options);
        const caseDir = await resolveCommandCase(dependencies, options, caseInput, workspaceRoot);
        return printJson(
          await dependencies.replay.startManualRun({
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
      usage: ["yk pbench finish --run RUN-ID"],
      run: async (args) => {
        const parsed = parseArgs(args);
        const runId = requireString(parsed, "run", "yk pbench finish requires --run <run-id>");
        return printJson(await dependencies.replay.finishRun({ runId, home: options.home }));
      }
    },
    {
      domain: "pbench",
      action: "finalize",
      description: "Finalize a strict-validated pbench transaction.",
      usage: ["yk pbench finalize --transaction PATH"],
      run: async (args) => {
        const parsed = parseArgs(args);
        const transaction = requireString(parsed, "transaction", "yk pbench finalize requires --transaction <path>");
        return printJson(await dependencies.finalizeTransaction(transaction));
      }
    },
    {
      domain: "pbench",
      action: "report",
      description: "Aggregate pbench run artifacts into a benchmark report.",
      usage: [
        "yk pbench report [--case CASE] [--workspace PATH] [--profile NAME] [--format markdown|json] [--include-untrusted]"
      ],
      run: async (args) => {
        const parsed = parseArgs(args);
        const workspaceRoot = await resolveCommandWorkspace(dependencies, parsed, options);
        const report = await dependencies.createPbenchReport({
          workspaceRoot,
          caseFilter: await dependencies.resolveReportCaseFilter({
            caseInput: getString(parsed, "case"),
            cwd: process.cwd(),
            home: options.home
          }),
          profileFilter: getString(parsed, "profile") ? normalizeRunProfile(getString(parsed, "profile")) : undefined,
          includeUntrusted: getBoolean(parsed, "include-untrusted")
        });
        const format = getString(parsed, "format") ?? "markdown";
        if (format === "markdown") {
          return dependencies.renderPbenchReportMarkdown(report);
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
      usage: ["yk pbench audit [--case CASE] [--workspace PATH]"],
      run: async (args) => {
        const parsed = parseArgs(args);
        const caseInput = getString(parsed, "case");
        if (caseInput) {
          const caseDir = await dependencies.resolveCaseDirInput({
            caseInput,
            cwd: process.cwd(),
            home: options.home,
            workspace: getString(parsed, "workspace")
          });
          return printJson(await dependencies.auditPbenchCase(caseDir));
        }
        const workspaceRoot = await resolveCommandWorkspace(dependencies, parsed, options);
        return printJson(await dependencies.auditPbenchWorkspace(workspaceRoot));
      }
    },
    {
      domain: "pbench",
      action: "workspace-init",
      description: "Initialize a pbench workspace.",
      usage: ["yk pbench workspace-init PATH"],
      run: async (args) => {
        const parsed = parseArgs(args);
        const path = parsed.positionals[0];
        if (!path) {
          throw new Error("yk pbench workspace-init requires <path>");
        }
        return printJson(await dependencies.initWorkspace(path));
      }
    },
    {
      domain: "pbench",
      action: "project-link",
      description: "Link the current project to a pbench workspace.",
      usage: ["yk pbench project-link --workspace PATH"],
      run: async (args) => {
        const parsed = parseArgs(args);
        const workspace = requireString(parsed, "workspace", "yk pbench project-link requires --workspace <path>");
        return printJson({ linkPath: await dependencies.linkProject(process.cwd(), workspace) });
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

async function resolveCommandWorkspace(
  dependencies: PbenchCommandDependencies,
  parsed: ParsedArgs,
  options: PbenchCommandOptions,
  createDefault?: boolean
): Promise<string> {
  return dependencies.resolveWorkspaceRoot({
    workspace: getString(parsed, "workspace"),
    cwd: process.cwd(),
    home: options.home,
    ...(createDefault === undefined ? {} : { createDefault })
  });
}

async function resolveCommandCase(
  dependencies: PbenchCommandDependencies,
  options: PbenchCommandOptions,
  caseInput: string,
  workspaceRoot: string
): Promise<string> {
  return dependencies.resolveCaseDirInput({
    caseInput,
    cwd: process.cwd(),
    home: options.home,
    workspace: workspaceRoot
  });
}

function printJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
