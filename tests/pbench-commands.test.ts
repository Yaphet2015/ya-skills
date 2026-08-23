import { expect, test } from "bun:test";
import { createCommands, type PbenchCommandDependencies } from "../packages/functions-pbench/src/commands.js";

function command(action: string, dependencies: PbenchCommandDependencies) {
  const item = createCommands(dependencies).find((candidate) => candidate.action === action);
  expect(item).toBeDefined();
  return item!;
}

test("commands delegate manual runs with normalized options", async () => {
  let request: unknown;
  const dependencies = {
    resolveWorkspaceRoot: async () => "/workspace",
    resolveCaseDirInput: async () => "/workspace/cases/case_one",
    replay: {
      startManualRun: async (value: unknown) => {
        request = value;
        return { runId: "run_one", status: "running" };
      }
    }
  } as unknown as PbenchCommandDependencies;

  const output = await command("run", dependencies).run([
    "--case",
    "case_one",
    "--manual",
    "--profile",
    " current "
  ]);

  expect(JSON.parse(String(output))).toEqual({ runId: "run_one", status: "running" });
  expect(request).toEqual({
    caseDir: "/workspace/cases/case_one",
    workspaceRoot: "/workspace",
    home: undefined,
    profile: "current",
    contaminated: false
  });
});

test("commands default reports to Markdown and preserve explicit JSON", async () => {
  const dependencies = {
    resolveWorkspaceRoot: async () => "/workspace",
    resolveReportCaseFilter: async () => undefined,
    createPbenchReport: async () => ({ schemaVersion: 1, totals: { runs: 0 } }),
    renderPbenchReportMarkdown: () => "# PBench Report\n",
    replay: {}
  } as unknown as PbenchCommandDependencies;

  const markdown = await command("report", dependencies).run([]);
  const json = await command("report", dependencies).run(["--format", "json"]);

  expect(markdown).toBe("# PBench Report\n");
  expect(JSON.parse(String(json))).toMatchObject({ schemaVersion: 1, totals: { runs: 0 } });
});
