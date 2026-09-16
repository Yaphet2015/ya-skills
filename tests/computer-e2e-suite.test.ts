import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SkipError,
  exitCodeFor,
  runSuite,
  validateSuite,
  type CaseContext,
  type Suite,
  type WorkerEvent
} from "../packages/functions-computer-e2e/src/suite.js";
import type { Computer } from "@ya-skills/computer-runtime";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeContext(): CaseContext {
  const unexpected = async (): Promise<never> => {
    throw new Error("unexpected computer call");
  };
  const artifactsDir = mkdtempSync(join(tmpdir(), "yk-suite-"));
  directories.push(artifactsDir);
  return {
    computer: {
      apps: unexpected,
      windows: unexpected,
      snapshot: unexpected,
      observe: unexpected,
      clickPoint: unexpected,
      batch: unexpected,
      click: unexpected,
      setValue: unexpected,
      type: unexpected,
      key: unexpected,
      scroll: unexpected,
      waitFor: unexpected
    },
    signal: new AbortController().signal,
    params: {},
    artifactsDir,
    step: async <T>(_name: string, work: () => Promise<T>) => await work(),
    skip: (reason: string) => {
      throw new SkipError(reason);
    },
    setApplication: () => {},
    capture: unexpected
  };
}

describe("runSuite (sequential, fail-stop)", () => {
  test("beforeAll failure runs afterAll once, marks cases not_run, records the phase", async () => {
    const order: string[] = [];
    const result = await runSuite(
      {
        apiVersion: 1,
        id: "fixture",
        name: "fixture",
        beforeAll() {
          order.push("boot");
          throw new Error("boot failed");
        },
        afterAll() {
          order.push("cleanup");
        },
        tests: [{ id: "never", name: "must not run", run() { order.push("BAD"); } }]
      },
      makeContext(),
      () => {}
    );
    expect(order).toEqual(["boot", "cleanup"]);
    expect(result.cases.map((c) => c.status)).toEqual(["not_run"]);
    expect(result.errors[0]!.phase).toBe("beforeAll");
    expect(result.errors[0]!.message).toMatch(/boot failed/);
  });

  test("a failed case stops the file; later cases are not_run; afterAll still runs once", async () => {
    const order: string[] = [];
    const result = await runSuite(
      {
        apiVersion: 1,
        id: "s",
        name: "s",
        afterAll() {
          order.push("afterAll");
        },
        tests: [
          { id: "a", name: "passes", run() { order.push("a"); } },
          { id: "b", name: "fails", run() { return Promise.reject(new Error("boom")); } },
          { id: "c", name: "never", run() { order.push("BAD"); } }
        ]
      },
      makeContext(),
      () => {}
    );
    expect(order).toEqual(["a", "afterAll"]);
    expect(result.cases.map((c) => c.status)).toEqual(["passed", "failed", "not_run"]);
    expect(result.cases[1]!.reason).toMatch(/boom/);
  });

  test("sync and async throws both fail the case", async () => {
    const result = await runSuite(
      {
        apiVersion: 1,
        id: "s",
        name: "s",
        tests: [
          { id: "sync", name: "sync throw", run() { throw new Error("sync boom"); } },
          { id: "async", name: "must not run", run() { throw new Error("never"); } }
        ]
      },
      makeContext(),
      () => {}
    );
    expect(result.cases[0]!.status).toBe("failed");
    expect(result.cases[1]!.status).toBe("not_run");
  });

  test("declared skip and runtime skip both record reasons without running", async () => {
    let ran = false;
    const result = await runSuite(
      {
        apiVersion: 1,
        id: "s",
        name: "s",
        tests: [
          { id: "declared", name: "declared", skip: "known gap", run() { ran = true; } },
          { id: "runtime", name: "runtime", run(ctx) { ctx.skip("condition unmet"); } }
        ]
      },
      makeContext(),
      () => {}
    );
    expect(result.cases.map((c) => c.status)).toEqual(["skipped", "skipped"]);
    expect(result.cases[0]!.reason).toBe("known gap");
    expect(result.cases[1]!.reason).toBe("condition unmet");
    expect(ran).toBe(false);
  });

  test("ctx.skip without a reason is a failure, not a skip", async () => {
    const result = await runSuite(
      {
        apiVersion: 1,
        id: "s",
        name: "s",
        tests: [{ id: "empty", name: "empty reason", run(ctx) { ctx.skip("   "); } }]
      },
      makeContext(),
      () => {}
    );
    expect(result.cases[0]!.status).toBe("failed");
  });

  test("an afterAll failure is recorded without masking the primary case error", async () => {
    const result = await runSuite(
      {
        apiVersion: 1,
        id: "s",
        name: "s",
        afterAll() {
          throw new Error("cleanup exploded");
        },
        tests: [{ id: "a", name: "fails", run() { throw new Error("primary"); } }]
      },
      makeContext(),
      () => {}
    );
    expect(result.cases[0]!.reason).toMatch(/primary/);
    expect(result.errors.map((e) => e.phase)).toContain("afterAll");
    expect(result.errors.map((e) => e.phase)).toContain("case");
  });

  test("a case exceeding its budget is interrupted and stops the file", async () => {
    const result = await runSuite(
      {
        apiVersion: 1,
        id: "s",
        name: "s",
        tests: [
          { id: "hang", name: "hangs", timeoutMs: 30, run() { return new Promise(() => {}); } },
          { id: "after", name: "must not run", run() { throw new Error("never"); } }
        ]
      },
      makeContext(),
      () => {}
    );
    expect(result.cases[0]!.status).toBe("interrupted");
    expect(result.cases[0]!.reason).toMatch(/timed out after 30ms/);
    expect(result.cases[1]!.status).toBe("not_run");
  });

  test("steps emit begin/end pairs bound to the running case", async () => {
    const events: WorkerEvent[] = [];
    const result = await runSuite(
      {
        apiVersion: 1,
        id: "s",
        name: "s",
        tests: [
          {
            id: "a",
            name: "two steps",
            async run(ctx) {
              await ctx.step("first", async () => undefined);
              await ctx.step("second", async () => undefined);
            }
          }
        ]
      },
      makeContext(),
      (event) => events.push(event)
    );
    const stepEvents = events.filter((e) => e.type.startsWith("step_"));
    expect(stepEvents.map((e) => `${e.type}:${(e.payload as { name: string }).name}`)).toEqual([
      "step_started:first",
      "step_finished:first",
      "step_started:second",
      "step_finished:second"
    ]);
    for (const event of stepEvents) {
      expect((event.payload as { caseId: string }).caseId).toBe("a");
    }
    expect(result.steps.map((s) => `${s.caseId}:${s.name}:${s.status}`)).toEqual([
      "a:first:passed",
      "a:second:passed"
    ]);
  });

  test("a failing step marks the step failed and the case failed", async () => {
    const result = await runSuite(
      {
        apiVersion: 1,
        id: "s",
        name: "s",
        tests: [
          {
            id: "a",
            name: "step throws",
            async run(ctx) {
              await ctx.step("inner", async () => {
                throw new Error("step boom");
              });
            }
          }
        ]
      },
      makeContext(),
      () => {}
    );
    expect(result.steps[0]!.status).toBe("failed");
    expect(result.steps[0]!.reason).toMatch(/step boom/);
    expect(result.cases[0]!.status).toBe("failed");
  });

  test("suite_collected is emitted before any hook event, with the full case list", async () => {
    const events: WorkerEvent[] = [];
    await runSuite(
      {
        apiVersion: 1,
        id: "s",
        name: "s",
        beforeAll() {},
        tests: [
          { id: "a", name: "first", timeoutMs: 1234, run() {} },
          { id: "b", name: "skipped one", skip: "why", run() {} }
        ]
      },
      makeContext(),
      (event) => events.push(event)
    );
    expect(events[0]!.type).toBe("suite_collected");
    const payload = events[0]!.payload as { cases: Array<{ id: string; timeoutMs: number; skip?: string }> };
    expect(payload.cases.map((c) => c.id)).toEqual(["a", "b"]);
    expect(payload.cases[0]!.timeoutMs).toBe(1234);
    expect(payload.cases[1]!.skip).toBe("why");
    expect(events[1]!.type).toBe("hook_started");
  });

  test("context passthrough: params keep identity and the computer delegates to the injected one", async () => {
    const base = makeContext();
    const params = { token: "x" } as Readonly<Record<string, string>>;
    let calls = 0;
    const injected: CaseContext = {
      ...base,
      params,
      computer: {
        ...base.computer,
        apps: async () => {
          calls++;
          return [];
        }
      }
    };
    let seenParams: unknown = null;
    await runSuite(
      {
        apiVersion: 1,
        id: "s",
        name: "s",
        tests: [
          {
            id: "a",
            name: "reads context",
            async run(ctx) {
              seenParams = ctx.params;
              await ctx.computer.apps();
            }
          }
        ]
      },
      injected,
      () => {}
    );
    expect(seenParams).toBe(params);
    expect(calls).toBe(1);
  });

  test("a timed-out case's zombie continuation is refused, not delivered", async () => {
    const base = makeContext();
    let zombieActed = 0;
    let zombieRefused = 0;
    const injected: CaseContext = {
      ...base,
      computer: {
        ...base.computer,
        apps: async () => {
          zombieActed++;
          return [];
        }
      }
    };
    const result = await runSuite(
      {
        apiVersion: 1,
        id: "s",
        name: "s",
        tests: [
          {
            id: "late",
            name: "acts after its own deadline",
            timeoutMs: 25,
            run(ctx) {
              return new Promise((resolve) => {
                setTimeout(() => {
                  // This continuation belongs to a case whose budget is gone.
                  try {
                    void ctx.computer.apps().then(
                      () => {
                        zombieActed++;
                        resolve();
                      },
                      () => {
                        zombieRefused++;
                        resolve();
                      }
                    );
                  } catch {
                    zombieRefused++; // the guard throws synchronously
                    resolve();
                  }
                }, 60);
              });
            }
          }
        ]
      },
      injected,
      () => {}
    );
    expect(result.cases[0]!.status).toBe("interrupted");
    await new Promise((r) => setTimeout(r, 100)); // let the zombie continuation fire
    expect(zombieActed).toBe(0);
    expect(zombieRefused).toBe(1);
  });
});

describe("validateSuite", () => {
  const minimal = {
    apiVersion: 1,
    id: "s",
    name: "s",
    tests: [{ id: "a", name: "a", run() {} }]
  };

  test("accepts the minimal shape", () => {
    expect(() => validateSuite(minimal)).not.toThrow();
  });

  test("rejects wrong apiVersion", () => {
    expect(() => validateSuite({ ...minimal, apiVersion: 2 })).toThrow(/apiVersion/);
  });

  test("rejects empty suites", () => {
    expect(() => validateSuite({ ...minimal, tests: [] })).toThrow(/at least one/i);
  });

  test("rejects duplicate case ids", () => {
    expect(() =>
      validateSuite({ ...minimal, tests: [...minimal.tests, { id: "a", name: "dup", run() {} }] })
    ).toThrow(/duplicate/i);
  });

  test("rejects non-function run", () => {
    expect(() => validateSuite({ ...minimal, tests: [{ id: "a", name: "a", run: "nope" }] })).toThrow(/run/i);
  });

  test("rejects negative and NaN budgets", () => {
    expect(() => validateSuite({ ...minimal, tests: [{ ...minimal.tests[0], timeoutMs: -1 }] })).toThrow(/timeoutMs/);
    expect(() => validateSuite({ ...minimal, tests: [{ ...minimal.tests[0], timeoutMs: Number.NaN }] })).toThrow(/timeoutMs/);
    expect(() => validateSuite({ ...minimal, hookTimeoutMs: Number.NaN })).toThrow(/hookTimeoutMs/);
  });

  test("rejects non-object values", () => {
    expect(() => validateSuite(null)).toThrow();
    expect(() => validateSuite(42)).toThrow();
  });
});

describe("exitCodeFor", () => {
  const result = (cases: Array<{ status: string }>, errors: unknown[] = []) =>
    ({ cases, steps: [], errors }) as never;

  test("all passed is 0", () => {
    expect(exitCodeFor(result([{ status: "passed" }]))).toBe(0);
  });

  test("any skipped or not_run (no failures) is 2", () => {
    expect(exitCodeFor(result([{ status: "passed" }, { status: "skipped" }]))).toBe(2);
    expect(exitCodeFor(result([{ status: "not_run" }]))).toBe(2);
  });

  test("no cases at all is 2", () => {
    expect(exitCodeFor(result([]))).toBe(2);
  });

  test("failures, interruptions, and errors are 1", () => {
    expect(exitCodeFor(result([{ status: "failed" }]))).toBe(1);
    expect(exitCodeFor(result([{ status: "interrupted" }]))).toBe(1);
    expect(exitCodeFor(result([{ status: "passed" }], [{ phase: "afterAll", message: "cleanup" }]))).toBe(1);
  });
});
