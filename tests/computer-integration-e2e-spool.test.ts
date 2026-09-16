import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { supervise, IncrementalE2ESpoolReader } from "../packages/functions-computer-e2e/src/supervisor.js";
import { EVENTS_FILE } from "../packages/functions-computer-e2e/src/history.js";
import { createIntegrationBurstFixture } from "./helpers/integration-e2e-burst.js";
import {
  INTEGRATION_SPOOL_CHUNK_BYTES,
  newlineAlignedIntegrationBurst,
  partialBoundaryIntegrationBurst
} from "./helpers/integration-e2e-spool.js";

interface RecordedEvent {
  type?: unknown;
  payload?: Record<string, unknown>;
}

function readEvents(path: string): RecordedEvent[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RecordedEvent);
}

describe("computer-e2e integration spool drain", () => {
  test("drains a newline-aligned burst larger than two chunks through the production reader", async () => {
    const root = mkdtempSync(join(tmpdir(), "yk-integration-e2e-spool-aligned-"));
    const path = join(root, "events.spool");
    const burst = newlineAlignedIntegrationBurst();
    writeFileSync(path, burst, { mode: 0o600 });
    const reader = new IncrementalE2ESpoolReader(path, INTEGRATION_SPOOL_CHUNK_BYTES);
    const lines: string[] = [];
    try {
      const first = reader.poll();
      lines.push(...first.lines);
      expect(first.bytesRead).toBe(INTEGRATION_SPOOL_CHUNK_BYTES);
      await reader.drainToEof((drained) => lines.push(...drained));
      expect(lines).toHaveLength(4);
      expect(lines.map((line) => JSON.parse(line).type)).toEqual([
        "case_finished",
        "hook_finished",
        "cleanup_finished",
        "run_finished"
      ]);
      expect(reader.finalize()).toEqual({ complete: true, pendingBytes: 0 });
    } finally {
      reader.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("drains a partial-frame boundary without false truncation or lost cleanup", async () => {
    const root = mkdtempSync(join(tmpdir(), "yk-integration-e2e-spool-partial-"));
    const path = join(root, "events.spool");
    const burst = partialBoundaryIntegrationBurst();
    writeFileSync(path, burst, { mode: 0o600 });
    const reader = new IncrementalE2ESpoolReader(path, INTEGRATION_SPOOL_CHUNK_BYTES);
    const lines: string[] = [];
    try {
      const first = reader.poll();
      lines.push(...first.lines);
      expect(first.bytesRead).toBe(INTEGRATION_SPOOL_CHUNK_BYTES);
      expect(lines.map((line) => JSON.parse(line).type)).toEqual(["case_finished"]);
      await reader.drainToEof((drained) => lines.push(...drained));
      expect(lines.map((line) => JSON.parse(line).type)).toEqual([
        "case_finished",
        "hook_finished",
        "cleanup_finished"
      ]);
      expect(reader.finalize()).toEqual({ complete: true, pendingBytes: 0 });
    } finally {
      reader.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const variant of [
    { name: "newline-aligned", namePadding: 0 },
    { name: "partial-frame-boundary", namePadding: 17 }
  ]) {
    test(`retains the worker-exit burst at a ${variant.name} boundary`, async () => {
      const cleanupSteps = 3_000;
      const fixture = createIntegrationBurstFixture({ cleanupSteps, namePadding: variant.namePadding });
      try {
        const result = await supervise({
          files: [fixture.suiteFile],
          params: {},
          outDir: fixture.outDir,
          timeoutMs: 60_000
        });
        const events = readEvents(join(fixture.outDir, result.runId, EVENTS_FILE));
        const cleanupFinished = events.filter(
          (event) => event.type === "step_finished" &&
            typeof event.payload?.name === "string" &&
            event.payload.name.startsWith("cleanup-")
        );
        expect(result.status).toBe("passed");
        expect(result.exitCode).toBe(0);
        expect(result.counts.passed).toBe(1);
        expect(result.counts.interrupted).toBe(0);
        expect(result.steps.filter((step) => step.name.startsWith("cleanup-")).length)
          .toBe(cleanupSteps + 1);
        expect(cleanupFinished.length).toBe(cleanupSteps + 1);
        expect(events.some((event) => event.type === "worker_protocol_error")).toBe(false);
        expect(events.some(
          (event) => event.type === "hook_finished" &&
            event.payload?.hook === "afterAll" &&
            event.payload?.status === "passed"
        )).toBe(true);
        expect(events.at(-1)?.type).toBe("run_finished");
      } finally {
        fixture.cleanup();
      }
    }, 90_000);
  }
});
