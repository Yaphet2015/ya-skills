import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EVENTS_FILE,
  createRunDir,
  eventLine,
  formatReport,
  readHistory,
  readRun,
  reduceEvents,
  type RunEvent
} from "../packages/functions-computer-e2e/src/history.js";

function ev(seq: number, type: RunEvent["type"], payload: Record<string, unknown>, runId = "r"): RunEvent {
  return { schemaVersion: 1, runId, seq, time: "2026-09-13T00:00:00Z", type, payload };
}

const STARTED = (extra: Record<string, unknown> = {}, runId = "r") =>
  ev(1, "run_started", { ykVersion: "0.18.0", ...extra }, runId);

const COLLECT = (file: string, cases: Array<{ id: string; name: string }>) =>
  ev(2, "suite_collected", { file, cases });

const CASE_START = (seq: number, file: string, id: string, timeoutMs = 30_000) =>
  ev(seq, "case_started", { file, id, timeoutMs });

const CASE_DONE = (seq: number, file: string, id: string, status: string, reason?: string) =>
  ev(seq, "case_finished", { file, id, status, ...(reason ? { reason } : {}) });

const FINISH = (seq: number, payload: Record<string, unknown> = {}, runId = "r") =>
  ev(seq, "run_finished", { exitCode: 0, status: "passed", ...payload }, runId);

describe("reduceEvents", () => {
  test("started-but-unfinished cases are interrupted; unstarted are not_run; no run_finished is incomplete", () => {
    const events = [
      STARTED(),
      COLLECT("a.e2e.ts", [
        { id: "a", name: "a" },
        { id: "b", name: "b" }
      ]),
      CASE_START(3, "a.e2e.ts", "a")
    ];
    const report = reduceEvents(events);
    expect(report.status).toBe("incomplete");
    expect(report.counts.passed).toBe(0);
    expect(report.counts.interrupted).toBe(1);
    expect(report.counts.not_run).toBe(1);
  });

  test("terminal failure is failed with exit 1", () => {
    const events = [
      STARTED(),
      COLLECT("a.e2e.ts", [{ id: "a", name: "a" }]),
      CASE_START(3, "a.e2e.ts", "a"),
      CASE_DONE(4, "a.e2e.ts", "a", "failed", "boom"),
      FINISH(5, { exitCode: 1, status: "failed" })
    ];
    const report = reduceEvents(events);
    expect(report.status).toBe("failed");
    expect(report.exitCode).toBe(1);
    expect(report.errors.join(" ")).toMatch(/boom/);
  });

  test("explicit skips pass the run with exit 2", () => {
    const events = [
      STARTED(),
      COLLECT("a.e2e.ts", [{ id: "a", name: "a" }]),
      CASE_START(3, "a.e2e.ts", "a"),
      CASE_DONE(4, "a.e2e.ts", "a", "skipped", "why"),
      FINISH(5, { exitCode: 2, status: "passed" })
    ];
    const report = reduceEvents(events);
    expect(report.status).toBe("passed");
    expect(report.exitCode).toBe(2);
    expect(report.counts.skipped).toBe(1);
  });

  test("primary errors and cleanupErrors are reported separately", () => {
    const events = [
      STARTED(),
      COLLECT("a.e2e.ts", [{ id: "a", name: "a" }]),
      ev(3, "hook_finished", { hook: "beforeAll", status: "failed", reason: "boot died" }),
      FINISH(5, { exitCode: 1, status: "failed", cleanupErrors: ["session close timed out"] })
    ];
    const report = reduceEvents(events);
    expect(report.errors.join(" ")).toMatch(/boot died/);
    expect(report.cleanupErrors).toEqual(["session close timed out"]);
  });

  test("an open action without its finished event is an unknown outcome, never passed", () => {
    const events = [
      STARTED(),
      COLLECT("a.e2e.ts", [{ id: "a", name: "a" }]),
      CASE_START(3, "a.e2e.ts", "a"),
      ev(4, "action_started", { kind: "click" }),
      CASE_DONE(5, "a.e2e.ts", "a", "passed"),
      FINISH(6)
    ];
    const report = reduceEvents(events);
    expect(report.errors.join(" ")).toMatch(/action outcome unknown: click/);
    expect(report.status).toBe("failed");
  });

  test("artifact paths may not escape the run directory", () => {
    const events = [
      STARTED(),
      COLLECT("a.e2e.ts", [{ id: "a", name: "a" }]),
      CASE_START(3, "a.e2e.ts", "a"),
      ev(4, "artifact", { path: "artifacts/shot.png" }),
      ev(5, "artifact", { path: "../../outside.png" }),
      CASE_DONE(6, "a.e2e.ts", "a", "passed"),
      FINISH(7)
    ];
    const report = reduceEvents(events);
    expect(report.artifacts).toEqual(["artifacts/shot.png"]);
    expect(report.errors.join(" ")).toMatch(/escapes the run directory/);
  });

  test("metadata accumulates runtime, application, and worker pids", () => {
    const events = [
      STARTED({ ykVersion: "9.9.9" }),
      ev(2, "runtime", { sdkVersion: "0.27.0" }),
      ev(3, "runtime", { workerPid: 4242 }),
      ev(4, "application", { name: "Cowork", environment: "staging" }),
      FINISH(5)
    ];
    const report = reduceEvents(events);
    expect(report.metadata.ykVersion).toBe("9.9.9");
    expect(report.metadata.sdkVersion).toBe("0.27.0");
    expect(report.metadata.workerPids).toEqual([4242]);
    expect((report.metadata.application as { name: string }).name).toBe("Cowork");
  });

  test("formatReport renders status, counts, and the incomplete warning", () => {
    const passing = reduceEvents([
      STARTED(),
      COLLECT("a.e2e.ts", [{ id: "a", name: "a" }]),
      CASE_START(3, "a.e2e.ts", "a"),
      CASE_DONE(4, "a.e2e.ts", "a", "passed"),
      FINISH(5)
    ]);
    const md = formatReport(passing);
    expect(md).toMatch(/status: \*\*passed\*\* \(exit 0\)/);
    expect(md).toMatch(/1 passed/);
    const broken = reduceEvents([STARTED()]);
    expect(formatReport(broken)).toMatch(/no terminal event/);
  });
});

describe("run directory records", () => {
  test("two runs get independent directories with private permissions", async () => {
    const base = join(tmpdir(), `yk-hist-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(base, { recursive: true });
    const a = createRunDir(base);
    const b = createRunDir(base);
    expect(a.runDir).not.toBe(b.runDir);
    expect(a.runId).not.toBe(b.runId);
    writeFileSync(
      join(a.runDir, EVENTS_FILE),
      eventLine(STARTED({}, a.runId)) + eventLine(FINISH(2, {}, a.runId))
    );
    writeFileSync(
      join(b.runDir, EVENTS_FILE),
      eventLine(STARTED({}, b.runId)) +
        eventLine(ev(2, "suite_collected", { file: "x.e2e.ts", cases: [{ id: "x", name: "x" }] }, b.runId)) +
        eventLine(ev(3, "case_started", { file: "x.e2e.ts", id: "x", timeoutMs: 30_000 }, b.runId)) +
        eventLine(ev(4, "case_finished", { file: "x.e2e.ts", id: "x", status: "skipped", reason: "why" }, b.runId)) +
        eventLine(FINISH(5, { exitCode: 2 }, b.runId))
    );
    const summaryA = readRun(a.runDir);
    const summaryB = readRun(b.runDir);
    expect(summaryA.counts.passed).toBe(0);
    expect(summaryA.status).toBe("passed");
    expect(summaryB.counts.skipped).toBe(1);
    expect(summaryB.exitCode).toBe(2);

    const history = await readHistory(base, 10);
    expect(history.length).toBe(2);
    expect(history.map((h) => h.runId).sort()).toEqual([a.runId, b.runId].sort());
  });

  test("an empty history directory is an empty list, not an error", async () => {
    const base = join(tmpdir(), `yk-hist-empty-${Date.now()}`);
    expect(await readHistory(base, 5)).toEqual([]);
  });

  test("a truncated tail keeps earlier events and reports incomplete", () => {
    const base = join(tmpdir(), `yk-hist-trunc-${Date.now()}`);
    const { runDir } = createRunDir(base);
    writeFileSync(
      join(runDir, EVENTS_FILE),
      eventLine(STARTED()) +
        eventLine(COLLECT("a.e2e.ts", [{ id: "a", name: "a" }])) +
        eventLine(CASE_START(3, "a.e2e.ts", "a")) +
        eventLine(CASE_DONE(4, "a.e2e.ts", "a", "passed")) +
        '{"schemaVersion":1,"runId":"r","seq":5,"time":"t","type":"run_fin'
    );
    const summary = readRun(runDir);
    expect(summary.counts.passed).toBe(1);
    expect(summary.status).toBe("incomplete");
    expect(summary.errors.join(" ")).toMatch(/truncated/);
  });

  test("a corrupt middle line refuses to report success", () => {
    const base = join(tmpdir(), `yk-hist-corrupt-${Date.now()}`);
    const { runDir } = createRunDir(base);
    writeFileSync(
      join(runDir, EVENTS_FILE),
      eventLine(STARTED()) +
        "NOT JSON AT ALL\n" +
        eventLine(FINISH(2))
    );
    const summary = readRun(runDir);
    expect(summary.status).not.toBe("passed");
    expect(summary.errors.join(" ")).toMatch(/corrupt|not a valid event/);
  });
});
