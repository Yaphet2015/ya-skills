import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathExists } from "./shared.js";
import type { HarborRun } from "./harbor-workflow.js";

type ReportOptions = { workspaceRoot: string; caseFilter?: string; profileFilter?: string };

function passAtFive(passes: number, attempts: number): number | null {
  if (attempts < 5) return null;
  const failures = attempts - passes;
  if (failures < 5) return 1;
  let allFailed = 1;
  for (let index = 0; index < 5; index += 1) allFailed *= (failures - index) / (attempts - index);
  return 1 - allFailed;
}

function average(values: (number | null)[]): number | null {
  const measured = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return measured.length ? measured.reduce((total, value) => total + value, 0) / measured.length : null;
}

export async function createHarborReport(options: ReportOptions) {
  const runsRoot = join(options.workspaceRoot, "runs");
  const runs: HarborRun[] = [];
  const warnings: string[] = [];
  if (await pathExists(runsRoot)) {
    for (const entry of (await readdir(runsRoot, { withFileTypes: true })).filter((item) => item.isDirectory())) {
      const path = join(runsRoot, entry.name, "run.json");
      if (!(await pathExists(path))) continue;
      try {
        const run = JSON.parse(await readFile(path, "utf8")) as HarborRun;
        if (run.schemaVersion !== 2) continue;
        if (!run.id || !run.caseId || !run.revision || !run.rewards || typeof run.rewardValid !== "boolean") {
          throw new Error("missing Harbor result fields");
        }
        if (options.caseFilter && options.caseFilter !== run.caseId) continue;
        if (options.profileFilter && options.profileFilter !== run.profile) continue;
        runs.push(run);
      } catch (error) {
        warnings.push(`${path}: ${(error as Error).message}`);
      }
    }
  }

  const groups = new Map<string, HarborRun[]>();
  for (const run of runs.sort((a, b) => a.id.localeCompare(b.id))) {
    const key = JSON.stringify([run.caseId, run.revision, run.profile, run.agent, run.model, run.agentVersion, run.envNames, run.skill]);
    const group = groups.get(key) ?? [];
    group.push(run);
    groups.set(key, group);
  }

  const comparisons = [...groups.values()].map((group) => {
    const { caseId, revision, profile, model, agent, agentVersion, envNames, skill } = group[0];
    const scored = group.filter((run) => run.rewardValid && [0, 1].includes(run.rewards.reward));
    const successful = scored.filter((run) => run.rewards.reward === 1);
    const passes = successful.length;
    const errors: Record<string, number> = {};
    for (const run of group) {
      if (!scored.includes(run)) {
        const reason = run.error ?? "invalid_reward";
        errors[reason] = (errors[reason] ?? 0) + 1;
      }
    }
    return {
      caseId, revision, profile, agent, model, agentVersion, envNames, skill, attempts: group.length,
      scored: scored.length, passes, passRate: scored.length ? passes / scored.length : null,
      passAt5: passAtFive(passes, scored.length),
      averageSuccessfulDurationMs: average(successful.map((run) => run.durationMs)),
      averageSuccessfulCostUsd: average(successful.map((run) => run.costUsd)),
      errors
    };
  });
  return { comparisons, runs, warnings };
}

export function renderHarborReport(report: Awaited<ReturnType<typeof createHarborReport>>): string {
  const cell = (value: string) => value.replace(/[\r\n|]/g, " ");
  const percent = (value: number | null) => value === null ? "—" : `${Math.round(value * 100)}%`;
  const lines = ["# PBench", "",
    "| Case | Snapshot | Profile | Agent | Model | Passed / scored | Attempts | Pass@5 |",
    "| --- | --- | --- | --- | --- | ---: | ---: | ---: |"
  ];
  for (const row of report.comparisons) {
    lines.push(`| ${cell(row.caseId)} | ${row.revision.slice(0, 12)} | ${cell(row.profile)} | ${cell(row.agent)} ${cell(row.agentVersion)} | ${cell(row.model)} | ${row.passes} / ${row.scored} | ${row.attempts} | ${percent(row.passAt5)} |`);
  }
  if (report.runs.length) lines.push("", "## Trials", "");
  for (const run of report.runs) {
    const score = run.rewardValid ? JSON.stringify(run.rewards) : run.error ?? "invalid reward";
    const assessment = run.verifierStatus === "pending" ? " · verifier pending at run time" : "";
    lines.push(`- \`${run.id}\` · ${cell(run.profile)} · ${cell(score)}${assessment} · \`${run.directory}\``);
  }
  if (report.warnings.length) lines.push("", ...report.warnings.map((warning) => `- ${warning}`));
  return lines.join("\n") + "\n";
}
