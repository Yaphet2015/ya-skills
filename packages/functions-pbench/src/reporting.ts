import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { JsonObject } from "./adapters/types.js";
import {
  assertPublicReplayHasNoPrivateReferences,
  buildPublicCaseManifest
} from "./replay-boundary.js";
import { PBENCH_RUN_STATUSES, type PbenchIntegrity } from "./run-types.js";
import { asArray, asObject, normalizeRunProfile, pathExists, readJson } from "./shared.js";

export type ReportQuery = {
  workspaceRoot: string;
  caseFilter?: string;
  profileFilter?: string;
  includeUntrusted?: boolean;
};

type PbenchReportRun = {
  runId: string;
  caseId: string;
  profile: string;
  status: string;
  artifactDir: string;
  summaryPath: string;
  agentMode: string;
  manualIntervention: boolean;
  isolation: string;
  integrity: PbenchIntegrity;
  validatorExecuted: boolean;
  agentVersion: string | null;
  terminal: boolean;
  attemptNumber: number;
  priorRunIds: string[];
  contaminated: boolean;
  failingValidatorId: string | null;
  accessAuditSuspicious: boolean;
  durationMs: number | null;
  tokenUsage: JsonObject;
  createdAt: string | null;
  updatedAt: string | null;
};

async function readRunArtifact(path: string): Promise<JsonObject> {
  try {
    const run = await readJson(path);
    if (
      run.schemaVersion !== 1 ||
      typeof run.runId !== "string" ||
      run.runId.length === 0 ||
      typeof run.caseId !== "string" ||
      run.caseId.length === 0 ||
      typeof run.status !== "string" ||
      !PBENCH_RUN_STATUSES.some((status) => status === run.status)
    ) {
      throw new Error("missing required run fields");
    }
    return run;
  } catch (error) {
    throw new Error(`Malformed pbench run artifact: ${path}: ${(error as Error).message}`);
  }
}

function normalizeIntegrity(value: unknown): PbenchIntegrity {
  return value === "enforced" || value === "instruction-only" || value === "contaminated" ? value : "unknown";
}

function normalizeReportRun(run: JsonObject): PbenchReportRun {
  const artifactDir = typeof run.artifactDir === "string" ? run.artifactDir : "";
  const priorRunIds = Array.isArray(run.priorRunIds) ? run.priorRunIds.map((id) => String(id)) : [];
  return {
    runId: String(run.runId ?? ""),
    caseId: String(run.caseId ?? ""),
    profile: normalizeRunProfile(typeof run.profile === "string" ? run.profile : undefined),
    status: String(run.status ?? "unknown"),
    artifactDir,
    summaryPath: join(artifactDir, "summary.md"),
    agentMode: String(run.agentMode ?? "unknown"),
    manualIntervention: run.manualIntervention === true,
    isolation: typeof run.isolation === "string" ? run.isolation : "none",
    integrity: normalizeIntegrity(run.integrity),
    validatorExecuted: run.validatorExecuted === true,
    agentVersion: typeof run.agentVersion === "string" ? run.agentVersion : null,
    terminal: run.terminal === true,
    attemptNumber: typeof run.attemptNumber === "number" ? run.attemptNumber : 1,
    priorRunIds,
    contaminated: run.contaminated === true,
    failingValidatorId: typeof run.failingValidatorId === "string" ? run.failingValidatorId : null,
    accessAuditSuspicious: run.accessAuditSuspicious === true,
    durationMs: typeof run.durationMs === "number" ? run.durationMs : null,
    tokenUsage: asObject(run.tokenUsage) ?? {},
    createdAt: typeof run.createdAt === "string" ? run.createdAt : null,
    updatedAt: typeof run.updatedAt === "string" ? run.updatedAt : null
  };
}

function incrementCount(record: Record<string, number>, key: string, amount = 1): void {
  record[key] = (record[key] ?? 0) + amount;
}

function addTokenUsage(target: Record<string, number>, tokenUsage: JsonObject): void {
  for (const [key, value] of Object.entries(tokenUsage)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      incrementCount(target, key, value);
    }
  }
}

function sortObjectValues<T>(input: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right)));
}

type ReportWarning = { category: "MALFORMED_RUN_ARTIFACT"; runId: string };

type ReportSummaryAccumulator = {
  runs: number;
  evaluated: number;
  passed: number;
  excludedStatusCounts: Record<string, number>;
  tokenUsage: Record<string, number>;
  durationTotal: number;
  durationCount: number;
};

type ReportCohortAccumulator = ReportSummaryAccumulator & {
  profile: string;
  agentMode: string;
  agentVersion: string | null;
  isolation: string;
  manualIntervention: boolean;
  integrity: PbenchIntegrity;
};

function createReportSummary(): ReportSummaryAccumulator {
  return {
    runs: 0,
    evaluated: 0,
    passed: 0,
    excludedStatusCounts: {},
    tokenUsage: {},
    durationTotal: 0,
    durationCount: 0
  };
}

function isDefaultEvaluatedRun(run: PbenchReportRun): boolean {
  return (
    run.terminal &&
    run.validatorExecuted &&
    run.integrity === "enforced" &&
    !run.contaminated &&
    (run.status === "passed" || run.status === "validator_failed")
  );
}

function isEvaluatedReportRun(run: PbenchReportRun, includeUntrusted: boolean): boolean {
  if (isDefaultEvaluatedRun(run)) {
    return true;
  }
  return (
    includeUntrusted &&
    run.terminal &&
    run.validatorExecuted &&
    run.integrity !== "contaminated" &&
    !run.contaminated &&
    (run.status === "passed" || run.status === "validator_failed")
  );
}

function excludedReportRunCategory(run: PbenchReportRun): string {
  if (run.status !== "passed" && run.status !== "validator_failed") {
    return run.status;
  }
  if (!run.terminal) {
    return "non_terminal";
  }
  if (!run.validatorExecuted) {
    return "validator_not_executed";
  }
  return "untrusted";
}

function addReportRun(summary: ReportSummaryAccumulator, run: PbenchReportRun, includeUntrusted: boolean): void {
  summary.runs += 1;
  if (isEvaluatedReportRun(run, includeUntrusted)) {
    summary.evaluated += 1;
    if (run.status === "passed") {
      summary.passed += 1;
    }
  } else {
    incrementCount(summary.excludedStatusCounts, excludedReportRunCategory(run));
  }
  if (typeof run.durationMs === "number") {
    summary.durationTotal += run.durationMs;
    summary.durationCount += 1;
  }
  addTokenUsage(summary.tokenUsage, run.tokenUsage);
}

function renderReportSummary(summary: ReportSummaryAccumulator): JsonObject {
  return {
    runs: summary.runs,
    evaluated: summary.evaluated,
    passed: summary.passed,
    passRate: summary.evaluated === 0 ? 0 : summary.passed / summary.evaluated,
    excludedStatusCounts: sortObjectValues(summary.excludedStatusCounts),
    averageDurationMs: summary.durationCount === 0 ? null : summary.durationTotal / summary.durationCount,
    tokenUsage: sortObjectValues(summary.tokenUsage)
  };
}

function reportCohortKey(run: PbenchReportRun): string {
  return JSON.stringify([
    run.profile,
    run.agentMode,
    run.agentVersion,
    run.isolation,
    run.manualIntervention,
    run.integrity
  ]);
}

async function listReportRuns(workspaceRoot: string): Promise<{ runs: PbenchReportRun[]; warnings: ReportWarning[] }> {
  const runsRoot = join(workspaceRoot, "runs");
  if (!(await pathExists(runsRoot))) {
    return { runs: [], warnings: [] };
  }
  const entries = await readdir(runsRoot, { withFileTypes: true });
  const runs: PbenchReportRun[] = [];
  const warnings: ReportWarning[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const runJsonPath = join(runsRoot, entry.name, "run.json");
    if (!(await pathExists(runJsonPath))) {
      continue;
    }
    try {
      runs.push(normalizeReportRun(await readRunArtifact(runJsonPath)));
    } catch {
      warnings.push({ category: "MALFORMED_RUN_ARTIFACT", runId: entry.name });
    }
  }
  return { runs, warnings };
}

export async function createPbenchReport(options: ReportQuery): Promise<JsonObject> {
  const filters: JsonObject = {};
  if (options.caseFilter) filters.caseId = options.caseFilter;
  if (options.profileFilter) filters.profile = options.profileFilter;
  if (options.includeUntrusted) filters.includeUntrusted = true;
  const listed = await listReportRuns(options.workspaceRoot);
  const runs = listed.runs.filter((run) => {
    if (options.caseFilter && run.caseId !== options.caseFilter) return false;
    if (options.profileFilter && run.profile !== options.profileFilter) return false;
    return true;
  });

  const statusCounts: Record<string, number> = {};
  const caseIds = new Set<string>();
  const profiles: Record<string, ReportSummaryAccumulator> = {};
  const cohorts: Record<string, ReportCohortAccumulator> = {};
  const cases: Record<string, { runs: number; profiles: Record<string, number>; statusCounts: Record<string, number> }> = {};
  let manualIntervention = 0;
  let contaminated = 0;

  for (const run of runs) {
    caseIds.add(run.caseId);
    incrementCount(statusCounts, run.status);
    if (run.manualIntervention) manualIntervention += 1;
    if (run.contaminated) contaminated += 1;

    profiles[run.profile] ??= createReportSummary();
    addReportRun(profiles[run.profile], run, options.includeUntrusted === true);

    const cohortKey = reportCohortKey(run);
    cohorts[cohortKey] ??= {
      ...createReportSummary(),
      profile: run.profile,
      agentMode: run.agentMode,
      agentVersion: run.agentVersion,
      isolation: run.isolation,
      manualIntervention: run.manualIntervention,
      integrity: run.integrity
    };
    addReportRun(cohorts[cohortKey], run, options.includeUntrusted === true);

    cases[run.caseId] ??= { runs: 0, profiles: {}, statusCounts: {} };
    cases[run.caseId].runs += 1;
    incrementCount(cases[run.caseId].profiles, run.profile);
    incrementCount(cases[run.caseId].statusCounts, run.status);
  }

  const renderedProfiles = sortObjectValues(
    Object.fromEntries(Object.entries(profiles).map(([name, profile]) => [name, renderReportSummary(profile)]))
  );
  const renderedCohorts = sortObjectValues(
    Object.fromEntries(
      Object.entries(cohorts).map(([key, cohort]) => [
        key,
        {
          profile: cohort.profile,
          agentMode: cohort.agentMode,
          agentVersion: cohort.agentVersion,
          isolation: cohort.isolation,
          manualIntervention: cohort.manualIntervention,
          integrity: cohort.integrity,
          ...renderReportSummary(cohort)
        }
      ])
    )
  );
  const renderedCases = sortObjectValues(
    Object.fromEntries(
      Object.entries(cases).map(([caseId, value]) => [
        caseId,
        {
          runs: value.runs,
          profiles: sortObjectValues(value.profiles),
          statusCounts: sortObjectValues(value.statusCounts)
        }
      ])
    )
  );

  const recentRuns = [...runs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")) || right.runId.localeCompare(left.runId))
    .slice(0, 20);

  return {
    schemaVersion: 1,
    workspaceRoot: options.workspaceRoot,
    filters,
    totals: {
      runs: runs.length,
      cases: caseIds.size,
      manualIntervention,
      contaminated,
      malformedArtifacts: listed.warnings.length,
      statusCounts: sortObjectValues(statusCounts)
    },
    profiles: renderedProfiles,
    cohorts: renderedCohorts,
    cases: renderedCases,
    recentRuns,
    warnings: listed.warnings
  };
}

function formatPercent(value: unknown): string {
  return `${((typeof value === "number" ? value : 0) * 100).toFixed(1)}%`;
}

function formatNullableNumber(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(Math.round(value)) : "";
}

function markdownCell(value: unknown): string {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|");
}

function formatCountRecord(value: unknown): string {
  const record = asObject(value) ?? {};
  return Object.entries(record)
    .map(([key, count]) => `${key}: ${String(count)}`)
    .join(", ");
}

export type AuditDependencies = {
  validateCaseBundle(caseDir: string): Promise<{ errors: string[]; warnings: string[] }>;
  findAuthoringWarnings(caseDir: string): Promise<string[]>;
};

export function createPbenchAudit(dependencies: AuditDependencies) {
  async function auditCase(caseDir: string): Promise<JsonObject> {
    const validation = await dependencies.validateCaseBundle(caseDir);
    const warnings = [...validation.warnings, ...await dependencies.findAuthoringWarnings(caseDir)];
    const errors = [...validation.errors];
    try {
      const manifest = await readJson(join(caseDir, "case.json"));
      await assertPublicReplayHasNoPrivateReferences(join(caseDir, "public"), {
        caseDir,
        extraSurfaces: [{ label: "case.public.json", text: JSON.stringify(buildPublicCaseManifest(manifest), null, 2) }]
      });
    } catch (error) {
      errors.push((error as Error).message);
    }
    let caseId = "";
    try {
      const manifest = await readJson(join(caseDir, "case.json"));
      caseId = typeof manifest.id === "string" ? manifest.id : "";
    } catch {
      // Validation already reports unreadable manifests.
    }
    return {
      schemaVersion: 1,
      caseId,
      ok: errors.length === 0 && warnings.length === 0,
      errors,
      warnings
    };
  }

  async function auditWorkspace(workspaceRoot: string): Promise<JsonObject> {
    const casesRoot = join(workspaceRoot, "cases");
    if (!(await pathExists(casesRoot))) {
      return {
        schemaVersion: 1,
        workspaceRoot,
        ok: true,
        totals: { cases: 0, passed: 0, failed: 0, warnings: 0 },
        cases: []
      };
    }
    const entries = (await readdir(casesRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));
    const cases: JsonObject[] = [];
    for (const entry of entries) {
      const audit = await auditCase(join(casesRoot, entry.name));
      cases.push({ ...audit, caseId: audit.caseId || entry.name });
    }
    const failed = cases.filter((audit) => audit.ok !== true).length;
    const warnings = cases.reduce(
      (total, audit) => total + (Array.isArray(audit.warnings) ? audit.warnings.length : 0),
      0
    );
    return {
      schemaVersion: 1,
      workspaceRoot,
      ok: failed === 0,
      totals: { cases: cases.length, passed: cases.length - failed, failed, warnings },
      cases
    };
  }

  return { auditCase, auditWorkspace };
}

export function renderPbenchReportMarkdown(report: JsonObject): string {
  const totals = asObject(report.totals) ?? {};
  const statusCounts = asObject(totals.statusCounts) ?? {};
  const profiles = asObject(report.profiles) ?? {};
  const cohorts = asObject(report.cohorts) ?? {};
  const cases = asObject(report.cases) ?? {};
  const recentRuns = asArray(report.recentRuns);
  const warnings = asArray(report.warnings);
  const lines = [
    "# PBench Report",
    "",
    `Workspace: ${String(report.workspaceRoot ?? "")}`,
    "",
    "## Totals",
    "",
    `Runs: ${String(totals.runs ?? 0)}`,
    `Cases: ${String(totals.cases ?? 0)}`,
    `Manual intervention: ${String(totals.manualIntervention ?? 0)}`,
    `Malformed artifacts: ${String(totals.malformedArtifacts ?? 0)}`,
    "",
    "## Status",
    "",
    "| Status | Runs |",
    "| --- | ---: |"
  ];
  for (const [status, count] of Object.entries(statusCounts)) {
    lines.push(`| ${status} | ${String(count)} |`);
  }
  if (Object.keys(statusCounts).length === 0) {
    lines.push("| none | 0 |");
  }

  lines.push(
    "",
    "## Profiles",
    "",
    "| Profile | Runs | Evaluated | Passed | Pass Rate | Excluded | Avg Duration (ms) | Input Tokens | Output Tokens |",
    "| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |"
  );
  for (const [name, rawProfile] of Object.entries(profiles)) {
    const profile = asObject(rawProfile) ?? {};
    const tokenUsage = asObject(profile.tokenUsage) ?? {};
    lines.push(
      `| ${name} | ${String(profile.runs ?? 0)} | ${String(profile.evaluated ?? 0)} | ${String(profile.passed ?? 0)} | ${formatPercent(profile.passRate)} | ${markdownCell(formatCountRecord(profile.excludedStatusCounts))} | ${formatNullableNumber(profile.averageDurationMs)} | ${String(tokenUsage.input_tokens ?? 0)} | ${String(tokenUsage.output_tokens ?? 0)} |`
    );
  }
  if (Object.keys(profiles).length === 0) {
    lines.push("| none | 0 | 0 | 0 | 0.0% |  |  | 0 | 0 |");
  }

  lines.push(
    "",
    "## Comparable Cohorts",
    "",
    "| Profile | Agent | Version | Isolation | Manual | Integrity | Runs | Evaluated | Passed | Pass Rate | Excluded |",
    "| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |"
  );
  for (const rawCohort of Object.values(cohorts)) {
    const cohort = asObject(rawCohort) ?? {};
    lines.push(
      `| ${markdownCell(cohort.profile)} | ${markdownCell(cohort.agentMode)} | ${markdownCell(cohort.agentVersion ?? "unknown")} | ${markdownCell(cohort.isolation)} | ${markdownCell(cohort.manualIntervention)} | ${markdownCell(cohort.integrity)} | ${markdownCell(cohort.runs ?? 0)} | ${markdownCell(cohort.evaluated ?? 0)} | ${markdownCell(cohort.passed ?? 0)} | ${formatPercent(cohort.passRate)} | ${markdownCell(formatCountRecord(cohort.excludedStatusCounts))} |`
    );
  }
  if (Object.keys(cohorts).length === 0) {
    lines.push("| none |  |  |  |  |  | 0 | 0 | 0 | 0.0% |  |");
  }

  lines.push("", "## Cases", "", "| Case | Runs | Profiles | Statuses |", "| --- | ---: | --- | --- |");
  for (const [caseId, rawCase] of Object.entries(cases)) {
    const caseSummary = asObject(rawCase) ?? {};
    lines.push(
      `| ${markdownCell(caseId)} | ${markdownCell(caseSummary.runs ?? 0)} | ${markdownCell(formatCountRecord(caseSummary.profiles))} | ${markdownCell(formatCountRecord(caseSummary.statusCounts))} |`
    );
  }
  if (Object.keys(cases).length === 0) {
    lines.push("| none | 0 |  |  |");
  }

  lines.push(
    "",
    "## Recent Runs",
    "",
    "| Run | Case | Profile | Status | Duration (ms) | Summary |",
    "| --- | --- | --- | --- | ---: | --- |"
  );
  for (const run of recentRuns) {
    lines.push(
      `| ${markdownCell(run.runId)} | ${markdownCell(run.caseId)} | ${markdownCell(run.profile)} | ${markdownCell(run.status)} | ${markdownCell(formatNullableNumber(run.durationMs))} | ${markdownCell(run.summaryPath)} |`
    );
  }
  if (recentRuns.length === 0) {
    lines.push("| none |  |  |  |  |  |");
  }

  lines.push("", "## Warnings", "", "| Category | Run |", "| --- | --- |");
  for (const warning of warnings) {
    lines.push(`| ${markdownCell(warning.category)} | ${markdownCell(warning.runId)} |`);
  }
  if (warnings.length === 0) {
    lines.push("| none |  |");
  }
  return `${lines.join("\n")}\n`;
}

