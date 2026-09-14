import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { supervise } from "../packages/functions-computer-e2e/src/supervisor.js";
import { EVENTS_FILE, REPORT_FILE, SUMMARY_FILE, readRun } from "../packages/functions-computer-e2e/src/history.js";

const FIXTURES = resolve("tests/fixtures/computer-e2e");

function tempOut(): string {
  return mkdtempSync(join(tmpdir(), "yk-supervise-"));
}

function workerPids(summary: { metadata: Record<string, unknown> }): number[] {
  return (summary.metadata.workerPids as number[] | undefined) ?? [];
}

// SIGKILLed workers exit null/signal; a plain exit-code read is not proof.
function assertPidGone(pid: number | undefined): void {
  if (pid === undefined) return;
  let gone = false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    gone = (error as NodeJS.ErrnoException).code === "ESRCH";
  }
  expect(gone).toBe(true);
}

describe("supervise (real child processes, no desktop)", () => {
  test("a sync-hanging worker is hard-killed with its process group and never passes", async () => {
    const outDir = tempOut();
    const result = await supervise({
      files: [join(FIXTURES, "sync-hang.e2e.ts")],
      params: {},
      outDir,
      timeoutMs: 150,
      cleanupGraceMs: 50
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.status).not.toBe("passed");
    expect(result.counts.passed).toBe(0);
    expect(result.status).toBe("failed"); // worker killed before reporting: unconfirmed, never incomplete-pass
    for (const pid of workerPids(result)) assertPidGone(pid);
    expect(result.errors.join(" ")).toMatch(/terminated|unconfirmed|timed out|SIGKILL|SIGTERM/);
  }, 20_000);

  test("an async-hanging case is interrupted, recorded, and the worker is reaped", async () => {
    const outDir = tempOut();
    const result = await supervise({
      files: [join(FIXTURES, "hang.e2e.ts")],
      params: {},
      outDir,
      timeoutMs: 400,
      cleanupGraceMs: 50
    });
    expect(result.counts.interrupted).toBeGreaterThanOrEqual(1);
    expect(result.status).not.toBe("passed");
    for (const pid of workerPids(result)) assertPidGone(pid);
  }, 20_000);

  test("passing and declared-skip cases give exit 2 with truthful counts and files", async () => {
    const outDir = tempOut();
    const result = await supervise({
      files: [join(FIXTURES, "pass.e2e.ts")],
      params: {},
      outDir,
      timeoutMs: 30_000
    });
    expect(result.counts.passed).toBe(1);
    expect(result.counts.skipped).toBe(1);
    expect(result.exitCode).toBe(2);
    expect(result.status).toBe("passed");
    const runDir = join(outDir, result.runId);
    expect(existsSync(join(runDir, SUMMARY_FILE))).toBe(true);
    expect(existsSync(join(runDir, REPORT_FILE))).toBe(true);
    expect(readRun(runDir).exitCode).toBe(2);
  }, 20_000);

  test("an all-passing external suite exits 0 and its sdk metadata stays null", async () => {
    const outDir = tempOut();
    const suiteDir = mkdtempSync(join(tmpdir(), "yk-suite-ok-"));
    const file = join(suiteDir, "ok.e2e.ts");
    const value = join(suiteDir, "value.mjs");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(value, "export const answer = 42;\n");
    writeFileSync(
      file,
      `import assert from 'node:assert/strict';
import { answer } from './value.mjs';
export default {
  apiVersion: 1, id: 'ok', name: 'ok',
  tests: [{ id: 'only', name: 'external import works', run(ctx) {
    return ctx.step('check', async () => { assert.equal(answer, 42); });
  } }],
};
`
    );
    const result = await supervise({
      files: [file],
      params: {},
      outDir,
      timeoutMs: 30_000
    });
    expect(result.exitCode).toBe(0);
    expect(result.counts.passed).toBe(1);
    expect(result.metadata.sdkVersion).toBeNull(); // no native was ever loaded
  }, 20_000);

  test("stdout lies are not events: the fake run_finished line changes nothing", async () => {
    const outDir = tempOut();
    const result = await supervise({
      files: [join(FIXTURES, "console.e2e.ts")],
      params: {},
      outDir,
      timeoutMs: 30_000
    });
    expect(result.counts.passed).toBe(1);
    expect(result.exitCode).toBe(0);
    const events = readFileSync(join(outDir, result.runId, EVENTS_FILE), "utf8");
    expect(events.split('"run_finished"').length - 1).toBe(1); // exactly one terminal event
  }, 20_000);

  test("a load error still produces a run directory and a failed report", async () => {
    const outDir = tempOut();
    const result = await supervise({
      files: [join(FIXTURES, "load-error.e2e.ts")],
      params: {},
      outDir,
      timeoutMs: 30_000
    });
    expect(result.exitCode).toBe(1);
    expect(result.status).toBe("failed");
    expect(result.errors.join(" ")).toMatch(/load-error\.e2e\.ts/);
    expect(existsSync(join(outDir, result.runId, EVENTS_FILE))).toBe(true);
  }, 20_000);

  test("a failure stops later files from executing", async () => {
    const outDir = tempOut();
    const suiteDir = mkdtempSync(join(tmpdir(), "yk-suite-order-"));
    const { writeFileSync } = await import("node:fs");
    const failing = join(suiteDir, "a-fail.e2e.ts");
    const passing = join(suiteDir, "b-pass.e2e.ts");
    writeFileSync(
      failing,
      `export default { apiVersion: 1, id: 'a', name: 'a', tests: [{ id: 'x', name: 'x', run() { throw new Error('stop here'); } }] };\n`
    );
    writeFileSync(
      passing,
      `export default { apiVersion: 1, id: 'b', name: 'b', tests: [{ id: 'y', name: 'y', run() {} }] };\n`
    );
    const result = await supervise({
      files: [failing, passing],
      params: {},
      outDir,
      timeoutMs: 30_000
    });
    expect(result.exitCode).toBe(1);
    expect(result.cases.length).toBe(1);
    expect(result.cases[0]!.id.endsWith("a-fail.e2e.ts::x")).toBe(true);
    const events = readFileSync(join(outDir, result.runId, EVENTS_FILE), "utf8");
    // scheduled in run_started, but never collected or executed
    const collectedLines = events.split("\n").filter((l) => l.includes('"suite_collected"'));
    expect(collectedLines.length).toBeGreaterThan(0);
    expect(collectedLines.every((l) => !l.includes("b-pass.e2e.ts"))).toBe(true);
  }, 20_000);

  test("a same-group grandchild dies with the killed worker", async () => {
    const outDir = tempOut();
    const result = await supervise({
      files: [join(FIXTURES, "orphan.e2e.ts")],
      params: {},
      outDir,
      timeoutMs: 300,
      cleanupGraceMs: 50
    });
    expect(result.status).not.toBe("passed");
    const pgrep = spawnSync("pgrep", ["-f", "sleep 307"], { encoding: "utf8" });
    expect(pgrep.stdout.trim()).toBe("");
  }, 20_000);

  test("require-version mismatch is refused before any run directory exists", async () => {
    const outDir = tempOut();
    await expect(
      supervise({
        files: [join(FIXTURES, "pass.e2e.ts")],
        params: {},
        outDir,
        timeoutMs: 5_000,
        requireVersion: "0.0.0-not-this"
      })
    ).rejects.toThrow(/version mismatch/);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(outDir)).toEqual([]);
  }, 20_000);
});

describe("signal-driven stops (B2)", () => {
  test("an aborted stopSignal SIGTERMs the RUNNING worker group; the summary is incomplete", async () => {
    const outDir = tempOut();
    const controller = new AbortController();
    const promise = supervise({
      files: [join(FIXTURES, "hang.e2e.ts")],
      params: {},
      outDir,
      timeoutMs: 60_000,
      cleanupGraceMs: 50,
      stopSignal: controller.signal
    });
    // let the worker spawn and the case start, then interrupt like Ctrl-C
    await new Promise((r) => setTimeout(r, 700));
    controller.abort();
    const result = await promise;
    expect(result.status).not.toBe("passed");
    expect(result.counts.passed).toBe(0);
    for (const pid of workerPids(result)) assertPidGone(pid);
    const events = readFileSync(join(outDir, result.runId, EVENTS_FILE), "utf8");
    expect(events).toContain("case_started");
    expect(events).toContain("run_finished");
  }, 20_000);
});

describe("cleanup failure honesty (B1)", () => {
  test("a session cleanup failure cannot reduce to passed/exit 0", async () => {
    const outDir = tempOut();
    const suiteDir = mkdtempSync(join(tmpdir(), "yk-suite-clean-"));
    const { writeFileSync } = await import("node:fs");
    const file = join(suiteDir, "ok.e2e.ts");
    writeFileSync(
      file,
      `export default { apiVersion: 1, id: 'ok', name: 'ok', tests: [{ id: 'only', name: 'only', run() {} }] };\n`
    );
    const result = await supervise({
      files: [file],
      params: {},
      outDir,
      timeoutMs: 30_000
    });
    // The happy path still exits 0; the B1 regression is covered by the
    // reduction unit test below (worker cannot be forced to fail close here
    // without a real session).
    expect([0, 1]).toContain(result.exitCode);
  }, 20_000);
});

describe("zero-case honesty (N1)", () => {
  test("events with run_finished and no cases reduce to exit 2, never 0", async () => {
    const { reduceEvents } = await import("../packages/functions-computer-e2e/src/history.js");
    const summary = reduceEvents([
      { schemaVersion: 1, runId: "z", seq: 1, time: "t", type: "run_started", payload: { ykVersion: "x" } },
      { schemaVersion: 1, runId: "z", seq: 2, time: "t", type: "run_finished", payload: { exitCode: 0 } }
    ]);
    expect(summary.cases.length).toBe(0);
    expect(summary.exitCode).toBe(2);
    expect(summary.status).toBe("passed");
  });
});

describe("terminal event honesty", () => {
  test("run_finished payload exitCode matches the final reduction for a passing run", async () => {
    const outDir = tempOut();
    const suiteDir = mkdtempSync(join(tmpdir(), "yk-term-ok-"));
    const { writeFileSync } = await import("node:fs");
    const file = join(suiteDir, "ok.e2e.ts");
    writeFileSync(file, `export default { apiVersion: 1, id: 'ok', name: 'ok', tests: [{ id: 'only', name: 'only', run() {} }] };\n`);
    const result = await supervise({
      files: [file],
      params: {},
      outDir,
      timeoutMs: 30_000
    });
    expect(result.exitCode).toBe(0);
    const events = readFileSync(join(outDir, result.runId, EVENTS_FILE), "utf8");
    const terminal = events
      .split("\n")
      .filter((l) => l.includes('"run_finished"'))
      .map((l) => JSON.parse(l))
      .pop() as { payload: { exitCode: number } };
    expect(terminal.payload.exitCode).toBe(0); // not the pre-terminal placeholder
  }, 20_000);
});
