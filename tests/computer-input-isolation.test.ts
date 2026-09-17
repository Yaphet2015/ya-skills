import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const probePath = resolve("scripts/probes/computer-input-isolation.ts");

function runReadOnlyProbe(): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [probePath], { env: process.env });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      const forceKill = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 1_000);
      forceKill.unref();
      reject(new Error("read-only input-isolation probe timed out after 30s"));
    }, 30_000);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    // `close` fires after stdout/stderr have drained. Reading `exit` can
    // resolve before the final JSON bytes reach the test process.
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveResult({ exitCode, stdout, stderr });
    });
  });
}

describe("input-isolation fixture gate", () => {
  test("the read-only probe reports current fixtures separately from historical evidence", async () => {
    const result = await runReadOnlyProbe();
    expect(result.exitCode, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as {
      driverStarted: boolean;
      desktopInputSent: boolean;
      checks: {
        fixtureSurface: {
          status: string;
          values?: {
            fixtures?: Array<Record<string, unknown>>;
            historicalFixtures?: Array<Record<string, unknown>>;
            historicalFixturesDoNotAffectStatus?: boolean;
            coordinateInputGate?: Record<string, unknown>;
          };
        };
      };
    };
    expect(report.driverStarted).toBe(false);
    expect(report.desktopInputSent).toBe(false);

    const surface = report.checks.fixtureSurface;
    expect(surface.status).toBe("observed");
    expect(surface.values?.historicalFixturesDoNotAffectStatus).toBe(true);
    expect(surface.values?.coordinateInputGate).toEqual({
      flag: "--allow-pointer",
      environment: "YK_INPUT_TEST_DESKTOP=1",
      requirement: "independent test desktop"
    });

    const current = surface.values?.fixtures ?? [];
    const native = current.find((fixture) => fixture.path === "scripts/probes/fixtures/computer-use-native.swift");
    expect(native).toMatchObject({
      status: "observed",
      historical: false,
      ignoresMouseEventsByDefault: true,
      ordersBack: true,
      pointerOptIn: true,
      independentDesktopGuard: true,
      guardedFrontOrder: true
    });

    const historical = surface.values?.historicalFixtures ?? [];
    expect(historical).toEqual([
      expect.objectContaining({
        path: "docs/verification/evidence/2026-09-16-native/NonKeyFixture.swift",
        historical: true,
        status: "unsupported"
      })
    ]);
  });
});
