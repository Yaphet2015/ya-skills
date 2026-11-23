import type { FunctionCommand } from "@ya-skills/core";
import { cp, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHarborWorkflow, harborTransaction } from "./harbor-workflow.js";
import { createHarborReport, renderHarborReport } from "./harbor-report.js";
import {
  absolutePath, initWorkspace, linkProject, resolveCaseDirInput, resolveReportCaseFilter, resolveWorkspaceRoot
} from "./workspace.js";
import { pathExists } from "./shared.js";
import { exportReplayCapsule } from "./authoring.js";
import { assertNoAgentVisiblePrivateReferences } from "./replay-boundary.js";

export type PbenchCommandOptions = { home?: string };
type Args = { options: Record<string, string | boolean>; positionals: string[] };

export function createCommands(workflow: ReturnType<typeof createHarborWorkflow>, { home }: PbenchCommandOptions = {}): FunctionCommand[] {
  const workspace = (args: Args, createDefault?: boolean) => resolveWorkspaceRoot({
    workspace: optional(args, "workspace"), home, createDefault
  });

  const casePath = (args: Args, root?: string) => resolveCaseDirInput({
    caseInput: required(args, "case"), cwd: process.cwd(), home, workspace: root ?? optional(args, "workspace")
  });

  async function location(args: Args) {
    const transaction = optional(args, "transaction");
    if (transaction) {
      if (optional(args, "case")) throw new Error("Use --case or --transaction.");
      return harborTransaction(absolutePath(transaction, process.cwd(), home));
    }
    const workspaceRoot = await workspace(args);
    return { caseDir: await casePath(args, workspaceRoot), workspaceRoot };
  }

  function command(action: string, description: string, usage: string, run: (args: Args) => Promise<unknown>): FunctionCommand {
    return {
      domain: "pbench", action, description, usage: [`yk pbench ${action} ${usage}`],
      run: async (argv) => {
        const result = await run(parseArgs(argv));
        return typeof result === "string" ? result : JSON.stringify(result, null, 2);
      }
    };
  }

  return [
    command("capture", "Capture session evidence and save a Harbor task.", "[--source codex|claude] [--input JSONL] [--session-id ID] [--task DIR] [--baseline-only] [--workspace PATH] [--yes]", async (args) => {
      const yes = args.options.yes === true;
      const template = optional(args, "task");
      return workflow.capture({
        source: optional(args, "source") ?? "codex",
        cwd: process.cwd(), home, yes,
        workspaceRoot: await workspace(args, yes),
        input: optional(args, "input"),
        sessionId: optional(args, "session-id"),
        title: optional(args, "title"),
        task: template ? absolutePath(template, process.cwd(), home) : undefined,
        baselineOnly: args.options["baseline-only"] === true
      });
    }),
    command("validate", "Check task readiness or score known failing and passing samples.", "(--case CASE | --transaction PATH) [--strict] [--fail SAMPLE] [--pass SAMPLE] [--workspace PATH]", async (args) => {
      const fail = optional(args, "fail");
      const pass = optional(args, "pass");
      const transaction = optional(args, "transaction");
      if (args.options.strict === true || fail || pass) return workflow.validate(await location(args), { fail, pass });
      return workflow.inspect(transaction ? (await location(args)).caseDir : await casePath(args));
    }),
    command("finalize", "Save the current Harbor environment as a local image archive.", "(--case CASE | --transaction PATH) [--workspace PATH]", async (args) => {
      const transaction = optional(args, "transaction");
      return workflow.save(transaction ? (await location(args)).caseDir : await casePath(args));
    }),
    command("export-replay", "Export only the Harbor task instruction.", "--case CASE --out DIR [--workspace PATH] [--force]", async (args) => {
      const caseDir = await casePath(args);
      const input = join(caseDir, "harbor", "instruction.md");
      const outDir = absolutePath(required(args, "out"), process.cwd(), home);
      if (!(await pathExists(input))) return exportReplayCapsule({ caseDir, outDir, force: args.options.force === true });
      assertNoAgentVisiblePrivateReferences([{ label: "instruction.md", text: await readFile(input, "utf8") }], [caseDir]);
      await mkdir(outDir, { recursive: true });
      const output = join(outDir, "instruction.md");
      await cp(input, output, { force: args.options.force === true, errorOnExist: true });
      return { outDir, exported: ["instruction.md"] };
    }),
    command("run", "Run a saved pbench task in Harbor Docker sandboxes.", "--case CASE --model MODEL [--agent codex|claude] [--attempts N] [--profile NAME] [--skill DIR] [--env NAME,NAME] [--workspace PATH]", async (args) => {
      if (args.options.manual) throw new Error("PBench uses Harbor trials. Supply --agent and --model.");
      const model = required(args, "model");
      const attempts = Number(optional(args, "attempts") ?? 1);
      if (!Number.isSafeInteger(attempts) || attempts < 1) throw new Error("--attempts must be a positive integer.");
      return workflow.run(await location(args), {
        agent: optional(args, "agent") ?? "codex", model, attempts, profile: optional(args, "profile"),
        skill: optional(args, "skill"),
        envNames: optional(args, "env")?.split(",").map((name) => name.trim()) ?? []
      });
    }),
    command("report", "Compare Harbor scores, configurations and trial artifacts.", "[--case CASE] [--profile NAME] [--format markdown|json] [--workspace PATH]", async (args) => {
      const format = optional(args, "format") ?? "markdown";
      if (format !== "markdown" && format !== "json") throw new Error("Choose markdown or json for --format.");
      const report = await createHarborReport({
        workspaceRoot: await workspace(args),
        caseFilter: await resolveReportCaseFilter({ caseInput: optional(args, "case"), cwd: process.cwd(), home }),
        profileFilter: optional(args, "profile")
      });
      return format === "markdown" ? renderHarborReport(report) : report;
    }),
    command("audit", "Review saved tasks and verifier status without running them.", "[--case CASE] [--workspace PATH]", async (args) => {
      if (optional(args, "case")) return workflow.inspect(await casePath(args));
      const root = join(await workspace(args), "cases");
      const cases = [];
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith("case_")) {
          cases.push({ caseId: entry.name, ...await workflow.inspect(join(root, entry.name)) });
        }
      }
      return { cases };
    }),
    command("workspace-init", "Initialize a local pbench workspace.", "PATH", async (args) => {
      if (!args.positionals[0]) throw new Error("yk pbench workspace-init requires PATH.");
      return initWorkspace(args.positionals[0]);
    }),
    command("project-link", "Link the current project to a pbench workspace.", "--workspace PATH", async (args) => ({
      linkPath: await linkProject(process.cwd(), required(args, "workspace"))
    }))
  ];
}

function parseArgs(args: string[]): Args {
  const options: Args["options"] = Object.create(null);
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
    } else {
      options[key] = next;
      index += 1;
    }
  }
  return { options, positionals };
}

function optional(args: Args, key: string): string | undefined {
  const value = args.options[key];
  if (value === true) throw new Error(`Supply a value for --${key}.`);
  return typeof value === "string" ? value : undefined;
}

function required(args: Args, key: string): string {
  const value = optional(args, key);
  if (!value) throw new Error(`Supply --${key}.`);
  return value;
}
