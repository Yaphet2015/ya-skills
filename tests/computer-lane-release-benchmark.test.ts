import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

interface BenchmarkSample {
  variant: string;
  success: boolean;
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
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  nativeMeasurementsAvailable: boolean;
}

describe("release lane: synthetic benchmark evidence", () => {
  test("measures equivalent four-action variants and reports unavailable native/model data", () => {
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/bench/computer-use.ts"), "--samples", "3", "--warmup", "1"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const rows = result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as BenchmarkSample);
    expect(rows.map((row) => row.variant)).toEqual(["single-step", "batch", "persistent-batch", "exec"]);
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.success).toBe(true);
      expect(row.sampleCount).toBe(3);
      expect(row.warmupCount).toBe(1);
      expect(row.failureCount).toBe(0);
      expect(row.warmupFailures).toBe(0);
      expect(row.durationMs).toBeGreaterThanOrEqual(0);
      expect(row.p95DurationMs).toBeGreaterThanOrEqual(row.durationMs);
      expect(row.warmupP50DurationMs).toBeGreaterThanOrEqual(0);
      expect(row.warmupP95DurationMs).toBeGreaterThanOrEqual(row.warmupP50DurationMs);
      expect(row.modelTurns).toBeNull();
      expect(row.inputTokens).toBeNull();
      expect(row.outputTokens).toBeNull();
      expect(row.reasoningTokens).toBeNull();
      expect(row.nativeMeasurementsAvailable).toBe(false);
    }
    const byVariant = new Map(rows.map((row) => [row.variant, row]));
    // Single-step uses four fresh synthetic runtimes per measured task;
    // batch uses one. Persistent batch and exec reuse one real host/fixture
    // driver across all three measured request IDs.
    expect(byVariant.get("single-step")?.driverInitializations).toBe(12);
    expect(byVariant.get("batch")?.driverInitializations).toBe(3);
    expect(byVariant.get("persistent-batch")?.driverInitializations).toBe(1);
    expect(byVariant.get("exec")?.driverInitializations).toBe(1);
    expect(byVariant.get("single-step")?.sampleCount).toBe(byVariant.get("batch")?.sampleCount);
  });
});
