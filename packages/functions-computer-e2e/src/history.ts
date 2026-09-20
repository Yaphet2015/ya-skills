// Run records: one directory per run, events.jsonl as the single source of
// truth, run.json/report.md derived from the same reduction. History reading
// never mutates existing runs and never loads the SDK.

import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { reduceResultEvents } from "./result-reducer.js";
import type { CaseResult, CaseStatus, StepResult } from "./types.js";
import type { WorkerEventType } from "./types.js";

export interface RunEvent {
  schemaVersion: 1;
  runId: string;
  seq: number;
  time: string;
  type: "run_started" | WorkerEventType | "run_finished" | "worker_protocol_error";
  payload: Record<string, unknown>;
}

export interface RunSummary {
  schemaVersion: 1;
  runId: string;
  status: "passed" | "failed" | "incomplete";
  exitCode: number;
  counts: Record<CaseStatus, number>;
  cases: CaseResult[];
  steps: StepResult[];
  errors: string[];
  cleanupErrors: string[];
  artifacts: string[];
  metadata: Record<string, unknown>;
}

export const EVENTS_FILE = "events.jsonl";
export const SUMMARY_FILE = "run.json";
export const REPORT_FILE = "report.md";
export const ARTIFACTS_DIR = "artifacts";

export function createRunDir(outDir: string): { runDir: string; runId: string } {
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  const runDir = join(outDir, runId);
  mkdirSync(runDir, { recursive: false, mode: 0o700 });
  return { runDir, runId };
}

export function eventLine(event: RunEvent): string {
  return `${JSON.stringify(event)}\n`;
}

const ZERO_COUNTS = (): Record<CaseStatus, number> => ({
  passed: 0,
  failed: 0,
  skipped: 0,
  not_run: 0,
  interrupted: 0
});

export function reduceEvents(events: readonly RunEvent[]): RunSummary {
  const runId = events[0]?.runId ?? "";
  const counts = ZERO_COUNTS();
  const reduction = reduceResultEvents(events, {
    caseId: (file, id) => `${file ?? "<unknown>"}::${id}`,
    includeInterruptedErrors: true,
    includeOpenSteps: true
  });
  const cleanupErrors: string[] = [];
  const metadata: Record<string, unknown> = {};
  let runFinished: RunEvent | undefined;
  const workerPids: number[] = [];

  for (const event of events) {
    const p = event.payload ?? {};
    switch (event.type) {
      case "run_started":
        Object.assign(metadata, p);
        break;
      case "runtime": {
        if (typeof p.sdkVersion === "string") metadata.sdkVersion = p.sdkVersion;
        if (typeof p.workerPid === "number") workerPids.push(p.workerPid);
        break;
      }
      case "application":
        if (typeof p.name === "string") metadata.application = p;
        break;
      case "run_finished": {
        runFinished = event;
        if (Array.isArray(p.cleanupErrors)) {
          for (const c of p.cleanupErrors) if (typeof c === "string") cleanupErrors.push(c);
        }
        break;
      }
      default:
        break;
    }
  }

  const { cases, steps } = reduction.suite;
  const errors = reduction.errors;
  const artifacts = reduction.artifacts;
  for (const item of cases) {
    const status = item.status;
    counts[status] += 1;
  }
  if (workerPids.length > 0) metadata.workerPids = workerPids;

  const failures = counts.failed > 0 || counts.interrupted > 0 || errors.length > 0;
  let status: RunSummary["status"];
  let exitCode: number;
  if (!runFinished) {
    status = "incomplete";
    exitCode = 1;
  } else if (failures) {
    status = "failed";
    exitCode = 1;
  } else if (counts.skipped > 0 || counts.not_run > 0 || cases.length === 0) {
    status = "passed";
    exitCode = 2;
  } else {
    status = "passed";
    exitCode = 0;
  }
  if (status === "incomplete" && failures === false && cases.length === 0) {
    // Nothing ran and nothing failed: still incomplete, never passed.
    status = "incomplete";
  }
  return {
    schemaVersion: 1,
    runId,
    status,
    exitCode,
    counts,
    cases,
    steps,
    errors,
    cleanupErrors,
    artifacts,
    metadata
  };
}

export function formatReport(summary: RunSummary): string {
  const lines: string[] = [];
  lines.push(`# computer-e2e run ${summary.runId}`, "");
  lines.push(`- status: **${summary.status}** (exit ${summary.exitCode})`);
  const m = summary.metadata;
  lines.push(
    `- yk: ${String(m.ykVersion ?? "?")} (${String(m.platform ?? "?")}/${String(m.arch ?? "?")}, bun ${String(m.bunVersion ?? "?")})`
  );
  lines.push(`- sdk: ${String(m.sdkVersion ?? "not loaded")}`);
  lines.push(`- cases: ${summary.counts.passed} passed, ${summary.counts.failed} failed, ${summary.counts.skipped} skipped, ${summary.counts.not_run} not_run, ${summary.counts.interrupted} interrupted`);
  lines.push("");
  if (summary.cases.length > 0) {
    lines.push("## Cases", "");
    for (const c of summary.cases) {
      lines.push(`- \`${c.status}\` **${c.name}** (${c.id})${c.reason ? ` — ${c.reason}` : ""}`);
    }
    lines.push("");
  }
  if (summary.errors.length > 0) {
    lines.push("## Errors", "");
    for (const e of summary.errors) lines.push(`- ${e}`);
    lines.push("");
  }
  if (summary.cleanupErrors.length > 0) {
    lines.push("## Cleanup errors", "");
    for (const e of summary.cleanupErrors) lines.push(`- ${e}`);
    lines.push("");
  }
  if (summary.artifacts.length > 0) {
    lines.push("## Artifacts", "");
    for (const a of summary.artifacts) lines.push(`- ${a}`);
    lines.push("");
  }
  if (summary.status === "incomplete") {
    lines.push("> This run has no terminal event — treat every result as unconfirmed.", "");
  }
  return `${lines.join("\n")}\n`;
}

export function readRun(runDir: string): RunSummary {
  const raw = readFileSync(join(runDir, EVENTS_FILE), "utf8");
  const events: RunEvent[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (i === lines.length - 1) {
        // truncated tail: keep earlier events, mark unconfirmed
        const summary = reduceEvents(events);
        summary.errors.push(`events.jsonl ends with a truncated line (line ${i + 1})`);
        if (summary.status === "passed") {
          summary.status = "incomplete";
          summary.exitCode = 1;
        }
        return summary;
      }
      const summary = reduceEvents(events);
      summary.errors.push(`events.jsonl contains a corrupt line ${i + 1} — refusing to report success`);
      summary.status = summary.status === "passed" ? "incomplete" : summary.status;
      summary.exitCode = 1;
      return summary;
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as RunEvent).type === "string" &&
      typeof (parsed as RunEvent).seq === "number"
    ) {
      events.push(parsed as RunEvent);
    } else {
      const summary = reduceEvents(events);
      summary.errors.push(`events.jsonl line ${i + 1} is not a valid event — refusing to report success`);
      summary.status = summary.status === "passed" ? "incomplete" : summary.status;
      summary.exitCode = 1;
      return summary;
    }
  }
  return reduceEvents(events);
}

export async function readHistory(outDir: string, limit: number): Promise<RunSummary[]> {
  let entries: string[];
  try {
    entries = readdirSync(outDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
  const summaries: RunSummary[] = [];
  for (const name of entries) {
    if (summaries.length >= limit) break;
    const runDir = join(outDir, name);
    try {
      summaries.push(readRun(runDir));
    } catch {
      // a directory without readable events.jsonl is not a run; skip it
    }
  }
  return summaries;
}
