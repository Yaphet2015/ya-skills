#!/usr/bin/env bun
// Desktop-free benchmark harness for the agentic computer-use variants.
// Every emitted line describes measured synthetic execution. No screen text,
// credentials, or image bytes are written. Model usage is null unless a caller
// supplies real provider usage; runtime round-trips are not model turns.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  runBatch,
  validateBatch,
  type Computer,
  type Observation,
  type Target
} from "@ya-skills/computer-runtime";
import { startHost, type HostConfig } from "../../packages/computer-session/src/host.js";
import { sendRequest } from "../../packages/computer-session/src/client.js";

interface Sample {
  variant: string;
  caseId: string;
  success: boolean;
  measured: boolean;
  durationMs: number;
  p95DurationMs: number;
  driverInitializations: number;
  modelTurns: number | null;
  observations: number;
  screenshots: number;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  recoveryEvents: string[];
  note?: string;
}

const ACTIONS = [
  { kind: "click", selector: { text: "Search", match: "exact" } },
  { kind: "type", text: "benchmark query" },
  { kind: "key", key: "Return" },
  { kind: "wait", condition: { kind: "element_exists", selector: { text: "Results", match: "contains" } }, timeoutMs: 2_000 }
] as const;

const TARGET: Target = { pid: 4242, windowId: 12345n };

function fakeObservation(target: Target): Observation {
  return {
    id: randomUUID(),
    target,
    capturedAt: Date.now(),
    epoch: "synthetic",
    revision: 0,
    title: "benchmark fixture",
    ax: {
      status: "usable",
      elements: [{ role: "AXStaticText", label: "Results" }],
      total: 1,
      returned: 1,
      complete: true
    },
    image: { status: "unavailable" }
  };
}

function fakeComputer(target: Target): Computer {
  return {
    apps: async () => [],
    windows: async () => [],
    snapshot: async () => ({ elements: [], title: "benchmark fixture" }),
    observe: async () => fakeObservation(target),
    clickPoint: async () => undefined,
    batch: async () => ({ status: "completed", steps: [] }),
    click: async () => undefined,
    type: async () => undefined,
    key: async () => undefined,
    scroll: async () => undefined,
    waitFor: async () => []
  };
}

async function benchBatchOnce(): Promise<{ ok: boolean; ms: number; observations: number; screenshots: number; driverInits: number }> {
  const started = Date.now();
  const result = await runBatch(
    fakeComputer(TARGET),
    TARGET,
    validateBatch({ actions: ACTIONS, observe: { mode: "auto" } })
  );
  return {
    ok: result.status === "completed",
    ms: Date.now() - started,
    observations: result.observation ? 1 : 0,
    screenshots: result.observation?.image.status === "usable" ? 1 : 0,
    driverInits: 1
  };
}

async function benchSingleStepOnce(): Promise<{ ok: boolean; ms: number; observations: number; screenshots: number; driverInits: number }> {
  const started = Date.now();
  let observations = 0;
  for (const action of ACTIONS) {
    const result = await runBatch(
      fakeComputer(TARGET),
      TARGET,
      validateBatch({ actions: [action], ...(action.kind === "wait" ? {} : {}) })
    );
    if (result.status !== "completed") return { ok: false, ms: Date.now() - started, observations, screenshots: 0, driverInits: observations + 1 };
    observations += result.observation ? 1 : 0;
  }
  return { ok: true, ms: Date.now() - started, observations, screenshots: 0, driverInits: ACTIONS.length };
}

async function benchSessionOnce(root: string): Promise<{ ok: boolean; ms: number; observations: number; screenshots: number; driverInits: number }> {
  const started = Date.now();
  const sessionId = randomUUID();
  const config: HostConfig = {
    schemaVersion: 1,
    sessionId,
    generation: randomUUID(),
    target: { pid: TARGET.pid, windowId: String(TARGET.windowId) },
    root,
    socketPath: join(tmpdir(), `yk-cu-bench-${sessionId.replace(/-/g, "").slice(0, 16)}.sock`),
    idleTimeoutMs: 120_000,
    requestsDir: join(root, "ignored-by-host"),
    inProcessDriver: {
      async call(method, args) {
        if (method === "observe") return fakeObservation(TARGET);
        if (method === "batch") {
          const actions = ((args.request as { actions?: readonly { kind: string }[] })?.actions ?? []);
          return { status: "completed", steps: actions.map((a, index) => ({ index, kind: a.kind, status: "delivered" })) };
        }
        return null;
      },
      async close() {}
    }
  };
  const host = await startHost(config, { driver: "in-process" });
  try {
    const reply = await sendRequest(
      config.socketPath,
      {
        schemaVersion: 1,
        sessionId,
        generation: config.generation,
        requestId: randomUUID(),
        operation: { kind: "batch", request: { actions: ACTIONS } }
      },
      30_000
    );
    const result = reply.result as { observation?: Observation } | undefined;
    return {
      ok: reply.status === "completed",
      ms: Date.now() - started,
      observations: result?.observation ? 1 : 0,
      screenshots: result?.observation?.image.status === "usable" ? 1 : 0,
      driverInits: 1
    };
  } finally {
    await host.close();
  }
}

async function benchExecOnce(root: string): Promise<{ ok: boolean; ms: number; observations: number; screenshots: number; driverInits: number }> {
  const started = Date.now();
  const sessionId = randomUUID();
  const config: HostConfig = {
    schemaVersion: 1,
    sessionId,
    generation: randomUUID(),
    target: { pid: TARGET.pid, windowId: String(TARGET.windowId) },
    root,
    socketPath: join(tmpdir(), `yk-cu-bench-${sessionId.replace(/-/g, "").slice(0, 16)}.sock`),
    idleTimeoutMs: 120_000,
    requestsDir: join(root, "ignored-by-host"),
    inProcessDriver: {
      async call(method, args) {
        if (method === "observe") return fakeObservation(TARGET);
        if (method === "batch") {
          const actions = ((args.request as { actions?: readonly { kind: string }[] })?.actions ?? []);
          return { status: "completed", steps: actions.map((a, index) => ({ index, kind: a.kind, status: "delivered" })) };
        }
        return null;
      },
      async close() {}
    }
  };
  const host = await startHost(config, { driver: "in-process" });
  try {
    const reply = await sendRequest(
      config.socketPath,
      {
        schemaVersion: 1,
        sessionId,
        generation: config.generation,
        requestId: randomUUID(),
        operation: {
          kind: "exec",
          code: "await computer.click({text:'Search',match:'exact'}); await computer.type('benchmark query'); await computer.key('Return'); return 1;",
          sourceName: join(root, "benchmark-flow.js"),
          timeoutMs: 30_000,
          maxActions: 10
        }
      },
      40_000
    );
    const result = reply.result as { observations?: Observation[] } | undefined;
    return {
      ok: reply.status === "completed",
      ms: Date.now() - started,
      observations: result?.observations?.length ?? 0,
      screenshots: result?.observations?.filter((o) => o.image.status === "usable").length ?? 0,
      driverInits: 1
    };
  } finally {
    await host.close();
  }
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return -1;
  return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)]!;
}

function emit(sample: Sample): void {
  console.log(JSON.stringify(sample));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const samples = Math.max(1, Number(args.includes("--samples") ? args[args.indexOf("--samples") + 1] ?? 10 : 10));
  const warmup = Math.max(0, Number(args.includes("--warmup") ? args[args.indexOf("--warmup") + 1] ?? 2 : 2));
  if (args.includes("--real")) {
    console.error("--real benchmarking requires an owned window under the strict Background protocol; refusing to auto-run (see docs/verification)");
    process.exitCode = 2;
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "yk-cu-bench-"));
  try {
    const variants: Array<[string, () => Promise<{ ok: boolean; ms: number; observations: number; screenshots: number; driverInits: number }>]> = [
      ["single-step", benchSingleStepOnce],
      ["batch", benchBatchOnce],
      ["session", () => benchSessionOnce(root)],
      ["exec", () => benchExecOnce(root)]
    ];
    for (const [variant, run] of variants) {
      for (let i = 0; i < warmup; i++) await run().catch(() => undefined);
      const durations: number[] = [];
      const recoveryEvents: string[] = [];
      let successes = 0;
      let observations = 0;
      let screenshots = 0;
      let driverInitializations = 0;
      for (let i = 0; i < samples; i++) {
        try {
          const result = await run();
          if (result.ok) successes++;
          if (result.ms >= 0) durations.push(result.ms);
          observations += result.observations;
          screenshots += result.screenshots;
          driverInitializations += result.driverInits;
          if (!result.ok) recoveryEvents.push(`sample ${i + 1} failed`);
        } catch (error) {
          recoveryEvents.push(`sample ${i + 1}: ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`);
        }
      }
      durations.sort((a, b) => a - b);
      emit({
        variant,
        caseId: "form-batch-4-actions",
        success: successes === samples,
        measured: true,
        durationMs: percentile(durations, 0.5),
        p95DurationMs: percentile(durations, 0.95),
        driverInitializations,
        // No model/provider is invoked by this harness; null prevents runtime
        // round-trips from being misreported as model turns or token usage.
        modelTurns: null,
        observations,
        screenshots,
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        recoveryEvents,
        note: `synthetic desktop-free samples=${samples}, warmup=${warmup}; model usage not supplied`
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

await main();
