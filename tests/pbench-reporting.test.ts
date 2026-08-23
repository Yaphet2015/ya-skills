import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPbenchReport, renderPbenchReportMarkdown } from "../packages/functions-pbench/src/reporting.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pbench-reporting-"));
  cleanup.push(root);
  return root;
}

async function writeRun(
  workspaceRoot: string,
  run: {
    runId: string;
    status: string;
    profile?: string;
    integrity?: string;
    validatorExecuted?: boolean;
    terminal?: boolean;
    agentVersion?: string;
    agentMode?: string;
    isolation?: string;
    manualIntervention?: boolean;
  }
): Promise<void> {
  const artifactDir = join(workspaceRoot, "runs", run.runId);
  await mkdir(artifactDir, { recursive: true });
  await writeFile(
    join(artifactDir, "run.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      runId: run.runId,
      caseId: "case_reporting_20260612T000000Z",
      profile: run.profile ?? "current",
      status: run.status,
      terminal: run.terminal ?? true,
      artifactDir,
      agentMode: run.agentMode ?? "codex",
      agentVersion: run.agentVersion ?? "1.0.0",
      manualIntervention: run.manualIntervention ?? false,
      isolation: run.isolation ?? "workspace-write",
      integrity: run.integrity ?? "enforced",
      validatorExecuted: run.validatorExecuted ?? true,
      contaminated: false,
      tokenUsage: { input_tokens: 2, output_tokens: 1 },
      updatedAt: "2026-06-12T00:00:00Z"
    }, null, 2)}\n`
  );
}

test("reporting returns an empty stable report", async () => {
  const workspaceRoot = await workspace();

  const report = await createPbenchReport({ workspaceRoot });

  expect(report).toMatchObject({
    schemaVersion: 1,
    workspaceRoot,
    totals: { runs: 0, cases: 0, malformedArtifacts: 0, statusCounts: {} },
    profiles: {},
    cohorts: {},
    recentRuns: [],
    warnings: []
  });
});

test("reporting separates trusted cohorts and tolerates malformed artifacts", async () => {
  const workspaceRoot = await workspace();
  await writeRun(workspaceRoot, { runId: "run_pass", status: "passed" });
  await writeRun(workspaceRoot, { runId: "run_fail", status: "validator_failed" });
  await writeRun(workspaceRoot, {
    runId: "run_untrusted",
    status: "passed",
    integrity: "instruction-only",
    agentVersion: "2.0.0"
  });
  await writeRun(workspaceRoot, {
    runId: "run_manual",
    status: "passed",
    agentMode: "codex",
    manualIntervention: true
  });
  const malformedDir = join(workspaceRoot, "runs", "run_malformed");
  await mkdir(malformedDir, { recursive: true });
  await writeFile(join(malformedDir, "run.json"), "PRIVATE_REPORT_SECRET not json\n");
  const invalidDir = join(workspaceRoot, "runs", "run_invalid");
  await mkdir(invalidDir, { recursive: true });
  await writeFile(join(invalidDir, "run.json"), '{"schemaVersion":1,"runId":"run_invalid","caseId":"case_x","status":"typo","secret":"PRIVATE_SCHEMA_SECRET"}\n');

  const report = await createPbenchReport({ workspaceRoot });
  const inclusive = await createPbenchReport({ workspaceRoot, includeUntrusted: true });
  const serialized = JSON.stringify(report);

  expect(report.profiles).toMatchObject({
    current: {
      runs: 4,
      evaluated: 3,
      passed: 2,
      passRate: 2 / 3,
      excludedStatusCounts: { untrusted: 1 }
    }
  });
  expect(Object.values(report.cohorts as Record<string, { agentVersion: string }>)).toHaveLength(3);
  expect(inclusive.profiles).toMatchObject({ current: { evaluated: 4, passed: 3 } });
  expect(report.warnings).toEqual(
    expect.arrayContaining([
      { category: "MALFORMED_RUN_ARTIFACT", runId: "run_malformed" },
      { category: "MALFORMED_RUN_ARTIFACT", runId: "run_invalid" }
    ])
  );
  expect(serialized).not.toContain("PRIVATE_REPORT_SECRET");
  expect(serialized).not.toContain("PRIVATE_SCHEMA_SECRET");
});

test("reporting keeps legacy runs visible but unevaluated", async () => {
  const workspaceRoot = await workspace();
  const artifactDir = join(workspaceRoot, "runs", "run_legacy");
  await mkdir(artifactDir, { recursive: true });
  await writeFile(
    join(artifactDir, "run.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      runId: "run_legacy",
      caseId: "case_legacy_20260612T000000Z",
      profile: "legacy",
      status: "passed",
      terminal: true,
      artifactDir,
      agentMode: "codex",
      isolation: "workspace-write"
    })}\n`
  );

  const report = await createPbenchReport({ workspaceRoot });

  expect(report.recentRuns).toEqual(
    expect.arrayContaining([expect.objectContaining({ integrity: "unknown", validatorExecuted: false })])
  );
  expect(report.profiles).toMatchObject({
    legacy: { evaluated: 0, passed: 0, excludedStatusCounts: { validator_not_executed: 1 } }
  });
});

test("reporting renders comparable cohorts as Markdown", async () => {
  const workspaceRoot = await workspace();
  await writeRun(workspaceRoot, { runId: "run_markdown", status: "passed" });

  const markdown = renderPbenchReportMarkdown(await createPbenchReport({ workspaceRoot }));

  expect(markdown).toContain("# PBench Report");
  expect(markdown).toContain("## Comparable Cohorts");
  expect(markdown).toContain("| current | codex | 1.0.0 | workspace-write | false | enforced |");
  expect(markdown).not.toContain("private/validators");
});
