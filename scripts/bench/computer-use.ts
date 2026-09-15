#!/usr/bin/env bun
// Desktop-free benchmark harness for the agentic computer-use variants.
// Every emitted line describes measured synthetic execution. No screen text,
// credentials, or image bytes are written. Model usage and native timing are
// unavailable here; runtime round-trips are not model turns.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  runBatch,
  validateBatch,
  ComputerError,
  type BatchRequest,
  type Computer,
  type Observation,
  type Target
} from "@ya-skills/computer-runtime";
import { startHost, type Host, type HostConfig } from "../../packages/computer-session/src/host.js";
import type { DriverSessionLike } from "../../packages/computer-session/src/driver-worker.js";
import { sendControl, sendRequest } from "../../packages/computer-session/src/client.js";

interface Sample {
  variant: string;
  caseId: string;
  success: boolean;
  measured: boolean;
  sampleCount: number;
  warmupCount: number;
  failureCount: number;
  warmupFailures: number;
  durationMs: number;
  p95DurationMs: number;
  warmupP50DurationMs: number;
  warmupP95DurationMs: number;
  driverInitializations: number;
  modelTurns: number | null;
  observations: number;
  screenshots: number;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  recoveryEvents: string[];
  nativeMeasurementsAvailable: false;
  note?: string;
}

interface Instrumentation {
  driverInitializations: number;
  actionCalls: number;
  observationCalls: number;
}

interface RunResult {
  ok: boolean;
  observations: number;
  screenshots: number;
  error?: string;
}

interface TimedResult extends RunResult {
  ms: number;
}

interface BenchHarness {
  run(): Promise<RunResult>;
  driverInitializations(): Promise<number>;
  close(): Promise<void>;
}

// One identical four-action task is used by every variant. The wait is part
// of the task (and is also present in EXEC_CODE); a variant may change the
// transport/orchestration, not the work being requested.
const ACTIONS: BatchRequest["actions"] = [
  { kind: "click", selector: { text: "Search", match: "exact" } },
  { kind: "type", text: "benchmark query" },
  { kind: "key", key: "Return" },
  { kind: "wait", condition: { kind: "element_exists", selector: { text: "Results", match: "contains" } }, timeoutMs: 2_000 }
];

const EXEC_CODE = `
  await computer.click({ text: "Search", match: "exact" });
  await computer.type("benchmark query");
  await computer.key("Return");
  await computer.wait(
    { kind: "element_exists", selector: { text: "Results", match: "contains" } },
    2000
  );
  return 1;
`;

const TARGET: Target = { pid: 4242, windowId: 12345n };
const OBSERVE_OPTIONS = { mode: "auto" as const };

function fakeObservation(target: Target): Observation {
  return {
    id: randomUUID(),
    target,
    capturedAt: Date.now(),
    epoch: "synthetic-fixture",
    revision: 0,
    title: "benchmark fixture",
    ax: {
      status: "usable",
      elements: [{ role: "AXStaticText", label: "Results" }],
      total: 1,
      returned: 1,
      complete: true
    },
    image: { status: "unavailable", reason: "synthetic benchmark has no native screenshot" }
  };
}

function newInstrumentation(): Instrumentation {
  return { driverInitializations: 0, actionCalls: 0, observationCalls: 0 };
}

function fakeComputer(target: Target, metrics: Instrumentation): Computer {
  // A fresh fake Computer represents one one-shot runtime/driver setup. This
  // is an observed fixture counter, not a claim about native initialization.
  metrics.driverInitializations++;
  return {
    apps: async () => [],
    windows: async () => [],
    snapshot: async () => ({ elements: [], title: "benchmark fixture" }),
    observe: async () => {
      metrics.observationCalls++;
      return fakeObservation(target);
    },
    clickPoint: async () => undefined,
    batch: async () => ({ status: "completed", steps: [] }),
    click: async () => undefined,
    type: async () => undefined,
    key: async () => undefined,
    scroll: async () => undefined,
    waitFor: async () => []
  };
}

function operationResult(result: Awaited<ReturnType<typeof runBatch>>): RunResult {
  return {
    ok: result.status === "completed",
    observations: result.observation ? 1 : 0,
    screenshots: result.observation?.image.status === "usable" ? 1 : 0,
    ...(result.status !== "completed" ? { error: `batch_${result.status}` } : {})
  };
}

function oneShotHarness(metrics: Instrumentation, batch: boolean): BenchHarness {
  return {
    async run(): Promise<RunResult> {
      if (batch) {
        const computer = fakeComputer(TARGET, metrics);
        const result = await runBatch(
          computer,
          TARGET,
          validateBatch({ actions: ACTIONS, observe: OBSERVE_OPTIONS })
        );
        return operationResult(result);
      }

      // Four one-action requests model the legacy single-step path. The final
      // request asks for the same terminal observation as batch/session/exec;
      // all four actions still use the exact shared ACTIONS list.
      let observations = 0;
      let screenshots = 0;
      for (const [index, action] of ACTIONS.entries()) {
        const computer = fakeComputer(TARGET, metrics);
        const result = await runBatch(
          computer,
          TARGET,
          validateBatch({
            actions: [action],
            ...(index === ACTIONS.length - 1 ? { observe: OBSERVE_OPTIONS } : {})
          })
        );
        const measured = operationResult(result);
        if (!measured.ok) return { ...measured, observations, screenshots };
        observations += measured.observations;
        screenshots += measured.screenshots;
      }
      return { ok: true, observations, screenshots };
    },
    async driverInitializations(): Promise<number> {
      return metrics.driverInitializations;
    },
    async close(): Promise<void> {}
  };
}

function makeInstrumentedDriver(target: Target, metrics: Instrumentation): DriverSessionLike {
  metrics.driverInitializations++;
  return {
    get initCount() {
      return metrics.driverInitializations;
    },
    async call(method, args, signal) {
      if (signal?.aborted) {
        throw new ComputerError("aborted", "synthetic driver call was aborted", "not_delivered");
      }
      if (method === "observe") {
        metrics.observationCalls++;
        return fakeObservation(target);
      }
      if (method === "batch") {
        const request = args.request as BatchRequest;
        metrics.actionCalls += request.actions.length;
        return {
          status: "completed",
          steps: request.actions.map((action, index) => ({
            index,
            kind: action.kind,
            status: action.kind === "wait" ? "satisfied" : "delivered"
          }))
        };
      }
      return null;
    },
    async close(): Promise<void> {}
  };
}

async function startPersistentHarness(root: string, variant: "batch" | "exec"): Promise<BenchHarness> {
  const metrics = newInstrumentation();
  const sessionId = randomUUID();
  const generation = randomUUID();
  const socketPath = join(tmpdir(), `yk-cu-bench-${sessionId.replace(/-/g, "").slice(0, 16)}.sock`);
  const config: HostConfig = {
    schemaVersion: 1,
    sessionId,
    generation,
    target: { pid: TARGET.pid, windowId: String(TARGET.windowId) },
    root,
    socketPath,
    idleTimeoutMs: 120_000,
    requestsDir: join(root, "ignored-by-host"),
    inProcessDriver: makeInstrumentedDriver(TARGET, metrics)
  };
  const host: Host = await startHost(config, { driver: "in-process" });
  let requestNumber = 0;

  return {
    async run(): Promise<RunResult> {
      const requestId = `bench-${++requestNumber}-${randomUUID()}`;
      const operation =
        variant === "batch"
          ? { kind: "batch" as const, request: { actions: ACTIONS, observe: OBSERVE_OPTIONS } }
          : {
              kind: "exec" as const,
              code: EXEC_CODE,
              sourceName: join(root, "benchmark-flow.js"),
              timeoutMs: 30_000,
              maxActions: 10
            };
      const reply = await sendRequest(
        socketPath,
        {
          schemaVersion: 1,
          sessionId,
          generation,
          requestId,
          operation
        },
        variant === "exec" ? 40_000 : 30_000
      );
      if (variant === "batch") {
        const result = reply.result as { observation?: Observation } | undefined;
        return {
          ok: reply.status === "completed",
          observations: result?.observation ? 1 : 0,
          screenshots: result?.observation?.image.status === "usable" ? 1 : 0,
          ...(reply.status !== "completed" ? { error: reply.error?.code ?? `reply_${reply.status}` } : {})
        };
      }
      const result = reply.result as { observations?: Observation[] } | undefined;
      return {
        ok: reply.status === "completed",
        observations: result?.observations?.length ?? 0,
        screenshots: result?.observations?.filter((observation) => observation.image.status === "usable").length ?? 0,
        ...(reply.status !== "completed" ? { error: reply.error?.code ?? `reply_${reply.status}` } : {})
      };
    },
    async driverInitializations(): Promise<number> {
      const control = await sendControl(
        socketPath,
        { kind: "diagnostics", schemaVersion: 1, sessionId },
        10_000
      );
      const count = control.diagnostics?.driverInitCount;
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1) {
        throw new Error(`instrumented driver did not report an initialization count: ${String(count)}`);
      }
      return count;
    },
    async close(): Promise<void> {
      await host.close();
    }
  };
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return -1;
  return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)]!;
}

async function timed(run: () => Promise<RunResult>): Promise<TimedResult> {
  const started = performance.now();
  try {
    const result = await run();
    return { ...result, ms: Math.max(0, Math.round(performance.now() - started)) };
  } catch (error) {
    return {
      ok: false,
      observations: 0,
      screenshots: 0,
      ms: Math.max(0, Math.round(performance.now() - started)),
      error: (error instanceof Error ? error.message : String(error)).slice(0, 160)
    };
  }
}

function emit(sample: Sample): void {
  console.log(JSON.stringify(sample));
}

function numericOption(args: string[], flag: string, fallback: number, minimum: number): number {
  const index = args.indexOf(flag);
  const raw = index === -1 ? String(fallback) : args[index + 1];
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${flag} must be an integer >= ${minimum}`);
  }
  return value;
}

async function measureVariant(
  variant: string,
  samples: number,
  warmup: number,
  root: string,
  createHarness: (phaseRoot: string) => Promise<BenchHarness> | BenchHarness
): Promise<void> {
  const warmupHarness = await createHarness(join(root, `${variant}-warmup`));
  const warmupResults: TimedResult[] = [];
  try {
    for (let i = 0; i < warmup; i++) warmupResults.push(await timed(() => warmupHarness.run()));
  } finally {
    await warmupHarness.close();
  }

  // The measured harness is intentionally kept alive for every sample. In
  // particular, persistent batch and exec send multiple request IDs through
  // one real session host/driver instead of opening a fresh host per sample.
  const measuredHarness = await createHarness(join(root, `${variant}-measured`));
  const measuredResults: TimedResult[] = [];
  try {
    for (let i = 0; i < samples; i++) measuredResults.push(await timed(() => measuredHarness.run()));
    const durations = measuredResults.map((result) => result.ms).sort((a, b) => a - b);
    const warmupDurations = warmupResults.map((result) => result.ms).sort((a, b) => a - b);
    const failures = measuredResults.filter((result) => !result.ok).length;
    const warmupFailures = warmupResults.filter((result) => !result.ok).length;
    const observations = measuredResults.reduce((total, result) => total + result.observations, 0);
    const screenshots = measuredResults.reduce((total, result) => total + result.screenshots, 0);
    const recoveryEvents = measuredResults.flatMap((result, index) =>
      result.ok ? [] : [`sample ${index + 1} failed${result.error ? `: ${result.error}` : ""}`]
    );
    emit({
      variant,
      caseId: "form-batch-4-actions",
      success: failures === 0,
      measured: true,
      sampleCount: samples,
      warmupCount: warmup,
      failureCount: failures,
      warmupFailures,
      durationMs: percentile(durations, 0.5),
      p95DurationMs: percentile(durations, 0.95),
      warmupP50DurationMs: percentile(warmupDurations, 0.5),
      warmupP95DurationMs: percentile(warmupDurations, 0.95),
      driverInitializations: await measuredHarness.driverInitializations(),
      // No model/provider is invoked by this harness; null prevents runtime
      // round-trips from being misreported as model turns or token usage.
      modelTurns: null,
      observations,
      screenshots,
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      recoveryEvents,
      nativeMeasurementsAvailable: false,
      note: `synthetic desktop-free runtime samples=${samples}, warmup=${warmup}; fixture init counts are observed but native timing/model/token usage is unavailable`
    });
  } finally {
    await measuredHarness.close();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const samples = numericOption(args, "--samples", 10, 1);
  const warmup = numericOption(args, "--warmup", 2, 0);
  if (args.includes("--real")) {
    console.error("--real benchmarking requires an owned window under the strict Background protocol; refusing to auto-run (see docs/verification)");
    process.exitCode = 2;
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "yk-cu-bench-"));
  try {
    await measureVariant("single-step", samples, warmup, root, () => oneShotHarness(newInstrumentation(), false));
    await measureVariant("batch", samples, warmup, root, () => oneShotHarness(newInstrumentation(), true));
    await measureVariant("persistent-batch", samples, warmup, root, (phaseRoot) => startPersistentHarness(phaseRoot, "batch"));
    await measureVariant("exec", samples, warmup, root, (phaseRoot) => startPersistentHarness(phaseRoot, "exec"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
