import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import packageJson from "../package.json" with { type: "json" };

// The packaged closed loop, desktop-free: install the skill from the
// packaged catalog, run external suites with the compiled yk under a
// PATH that has no node/npm/bun, and read back history + report.
// YK_RELEASE_TESTS=1 (release runners): missing artifacts FAIL here.
// Default local runs: skip unless dist/release exists.

const outDir = resolve("dist/release/ya-skills");
const yk = join(outDir, "yk");
const ready = existsSync(yk) && process.platform === "darwin" && process.arch === "arm64";
const required = process.env.YK_RELEASE_TESTS === "1";
const maybe = ready ? test : required ? test : test.skip;

function consumerDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `yk-rel-${label}-`));
}

function runYk(cwd: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync([yk, ...args], {
    cwd,
    env: {
      ...process.env,
      PATH: "/usr/bin:/bin",
      NODE_PATH: "",
      BUN_OPTIONS: "",
      YA_SKILLS_CATALOG_DIR: join(outDir, "skills")
    },
    stdout: "pipe",
    stderr: "pipe"
  });
  return {
    code: proc.exitCode,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr)
  };
}

describe("packaged computer-e2e closed loop (no desktop, no node/npm/bun on PATH)", () => {
  maybe("release artifacts must exist when YK_RELEASE_TESTS=1", () => {
    expect(required ? existsSync(yk) : true).toBe(true);
    expect(existsSync(join(outDir, "skills", "computer-e2e", "references", "api.d.ts"))).toBe(true);
    expect(existsSync(join(outDir, "runtime", "computer-use", "node_modules", "@trycua", "cua-driver", "dist", "index.js"))).toBe(true);
  });

  maybe("install + run + history + report through the compiled yk", () => {
    const consumer = consumerDir("loop");
    try {
      const install = runYk(consumer, ["install", "computer-e2e"]);
      expect(install.code).toBe(0);
      expect(install.stdout).toContain("computer-e2e");
      expect(existsSync(join(consumer, ".agents/skills/computer-e2e/references/api.d.ts"))).toBe(true);
      expect(existsSync(join(consumer, "node_modules"))).toBe(false);

      // The packaged example suite: one pass + one declared skip -> exit 2.
      const example = join(consumer, ".agents/skills/computer-e2e/examples/pure.e2e.ts");
      const run = runYk(consumer, ["computer-e2e", "run", example]);
      expect(run.code).toBe(2);
      const summary = JSON.parse(run.stdout) as {
        runId: string;
        counts: Record<string, number>;
        metadata: Record<string, unknown>;
      };
      expect(summary.counts.passed).toBe(1);
      expect(summary.counts.skipped).toBe(1);
      expect(summary.metadata.sdkVersion).toBeNull(); // pure suites never load native
      expect(summary.metadata.ykVersion).toBe(packageJson.version);

      // A failing suite exits 1 and names the case.
      const failing = join(consumer, "fail.e2e.ts");
      writeFileSync(
        failing,
        `export default { apiVersion: 1, id: 'f', name: 'f', tests: [{ id: 'x', name: 'x', run() { throw new Error('release-boom'); } }] };\n`
      );
      const fail = runYk(consumer, ["computer-e2e", "run", failing]);
      expect(fail.code).toBe(1);
      expect(fail.stdout).toContain("release-boom");

      // history + report read only files.
      const history = runYk(consumer, ["computer-e2e", "history"]);
      expect(history.code).toBe(0);
      const runs = JSON.parse(history.stdout) as Array<{ runId: string }>;
      expect(runs.length).toBeGreaterThanOrEqual(2);
      const report = runYk(consumer, ["computer-e2e", "report", join(consumer, ".computer-e2e/runs", summary.runId)]);
      expect(report.code).toBe(0);
      expect(report.stdout).toContain("plain assertions need no desktop");
      expect(report.stdout).toContain("declared skip keeps exit code honest");
    } finally {
      rmSync(consumer, { recursive: true, force: true });
    }
  });

  maybe("external TS relative imports work; hostile package.json does not stop the run", () => {
    const consumer = mkdtempSync(join(tmpdir(), "yk rel spaced dir-"));
    try {
      writeFileSync(
        join(consumer, "package.json"),
        JSON.stringify({
          name: "hostile",
          version: "1.0.0",
          scripts: { preinstall: "touch SENTINEL_RAN", prepare: "touch SENTINEL_RAN" }
        })
      );
      writeFileSync(join(consumer, "value.mjs"), "export const answer = 42;\n");
      writeFileSync(
        join(consumer, "ok.e2e.ts"),
        `import assert from 'node:assert/strict';
import { answer } from './value.mjs';
export default { apiVersion: 1, id: 'ok', name: 'ok', tests: [{ id: 'only', name: 'only', run() { assert.equal(answer, 42); } }] };\n`
      );
      const run = runYk(consumer, ["computer-e2e", "run", "ok.e2e.ts"]);
      expect(run.code).toBe(0);
      expect(existsSync(join(consumer, "SENTINEL_RAN"))).toBe(false);
      expect(existsSync(join(consumer, "node_modules"))).toBe(false);
    } finally {
      rmSync(consumer, { recursive: true, force: true });
    }
  });
});
