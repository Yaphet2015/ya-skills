import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseE2EArgs } from "../packages/functions-computer-e2e/src/args.js";

describe("parseE2EArgs run", () => {
  test("files, params, out-dir, timeout, require-version parse cleanly", () => {
    const parsed = parseE2EArgs("run", [
      "a.e2e.ts",
      "b.e2e.ts",
      "--param",
      "app-root=/x",
      "--param",
      "empty=",
      "--out-dir",
      "runs",
      "--timeout-ms",
      "5000",
      "--require-version",
      "0.18.0"
    ]);
    expect(parsed).toEqual({
      action: "run",
      files: ["a.e2e.ts", "b.e2e.ts"],
      params: { "app-root": "/x", empty: "" },
      outDir: "runs",
      timeoutMs: 5000,
      requireVersion: "0.18.0"
    });
  });

  test("defaults: out-dir .computer-e2e/runs, timeout 900000, no params", () => {
    const parsed = parseE2EArgs("run", ["only.e2e.ts"]);
    expect(parsed.outDir).toBe(".computer-e2e/runs");
    expect(parsed.timeoutMs).toBe(900000);
    expect(parsed.params).toEqual({});
    expect(parsed.requireVersion).toBeUndefined();
  });

  test("run without files is an input error", () => {
    expect(() => parseE2EArgs("run", [])).toThrow(/at least one/i);
    expect(() => parseE2EArgs("run", ["--out-dir", "x"])).toThrow(/at least one/i);
  });

  test("duplicate param keys are rejected", () => {
    expect(() => parseE2EArgs("run", ["a.e2e.ts", "--param", "x=1", "--param", "x=2"])).toThrow(/duplicate/);
  });

  test("params need key=value and a non-empty key", () => {
    expect(() => parseE2EArgs("run", ["a.e2e.ts", "--param", "novalue"])).toThrow(/key=value/i);
    expect(() => parseE2EArgs("run", ["a.e2e.ts", "--param", "=v"])).toThrow(/key=value/i);
  });

  test("unknown flags are rejected before anything runs", () => {
    expect(() => parseE2EArgs("run", ["a.e2e.ts", "--retry", "3"])).toThrow(/unknown/i);
    expect(() => parseE2EArgs("run", ["a.e2e.ts", "--foreground"])).toThrow(/unknown/i);
  });

  test("single-value flags given twice are rejected", () => {
    expect(() => parseE2EArgs("run", ["a.e2e.ts", "--out-dir", "x", "--out-dir", "y"])).toThrow(/twice/i);
    expect(() => parseE2EArgs("run", ["a.e2e.ts", "--require-version", "1", "--require-version", "2"])).toThrow(/twice/i);
  });

  test("the budget must be a positive integer", () => {
    expect(() => parseE2EArgs("run", ["a.e2e.ts", "--timeout-ms", "0"])).toThrow(/timeout-ms/i);
    expect(() => parseE2EArgs("run", ["a.e2e.ts", "--timeout-ms", "-5"])).toThrow(/timeout-ms/i);
    expect(() => parseE2EArgs("run", ["a.e2e.ts", "--timeout-ms", "soon"])).toThrow(/timeout-ms/i);
  });

  test("missing values are input errors, not consumed positionals", () => {
    expect(() => parseE2EArgs("run", ["a.e2e.ts", "--out-dir"])).toThrow(/value/i);
    expect(() => parseE2EArgs("run", ["a.e2e.ts", "--param"])).toThrow(/value/i);
  });

  test("flags after -- are still flags; bare dash tokens are files (shell expanded globs arrive as paths)", () => {
    const parsed = parseE2EArgs("run", ["weird name.e2e.ts"]);
    expect(parsed.files).toEqual(["weird name.e2e.ts"]);
  });
});

describe("parseE2EArgs history/report", () => {
  test("history defaults and --limit", () => {
    expect(parseE2EArgs("history", [])).toEqual({ action: "history", outDir: ".computer-e2e/runs", limit: 20 });
    expect(parseE2EArgs("history", ["--out-dir", "runs", "--limit", "3"])).toEqual({
      action: "history",
      outDir: "runs",
      limit: 3
    });
  });

  test("history rejects positionals and bad limits", () => {
    expect(() => parseE2EArgs("history", ["oops"])).toThrow(/no positional/i);
    expect(() => parseE2EArgs("history", ["--limit", "0"])).toThrow(/limit/i);
  });

  test("report takes exactly one run directory", () => {
    expect(parseE2EArgs("report", [".computer-e2e/runs/R1"])).toEqual({
      action: "report",
      runDir: ".computer-e2e/runs/R1"
    });
    expect(() => parseE2EArgs("report", [])).toThrow(/exactly one/i);
    expect(() => parseE2EArgs("report", ["a", "b"])).toThrow(/exactly one/i);
    expect(() => parseE2EArgs("report", ["a", "--limit", "3"])).toThrow(/not valid/i);
  });

  test("unknown actions are rejected", () => {
    expect(() => parseE2EArgs("explode", [])).toThrow(/unknown action/i);
  });
});

describe("api.d.ts generation", () => {
  test("regenerating produces exactly the committed reference (no drift, no workspace mutation)", async () => {
    const committed = readFileSync(resolve("skills/computer-e2e/references/api.d.ts"), "utf8");
    const temp = await mkdtemp(join(tmpdir(), "yk-api-"));
    try {
      const target = join(temp, "api.d.ts");
      const proc = Bun.spawnSync(["bun", "scripts/generate-computer-e2e-api.ts", "--out", target], {
        cwd: resolve("."),
        stdout: "pipe",
        stderr: "pipe"
      });
      expect(proc.exitCode).toBe(0);
      expect(readFileSync(target, "utf8")).toBe(committed);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});

describe("release pipelines", () => {
  test("gates run in the fixed order (asserted by position, not just presence)", async () => {
    for (const workflow of ["release.yml", "release-please.yml"]) {
      const text = await Bun.file(resolve(".github/workflows", workflow)).text();
      const at = (needle: string): number => text.indexOf(needle);
      const typecheck = at("bun run typecheck");
      const test = at("bun test");
      const pkg = at("bun run package:release");
      const closedLoop = at("YK_RELEASE_TESTS=1 bun test tests/computer-e2e-release.test.ts");
      const build = at("bun run build");
      const smoke = at("bun run smoke");
      for (const [label, pos] of [
        ["typecheck", typecheck],
        ["test", test],
        ["package", pkg],
        ["closed-loop", closedLoop],
        ["build", build],
        ["smoke", smoke]
      ] as const) {
        expect(pos).toBeGreaterThanOrEqual(0);
      }
      expect(typecheck).toBeLessThan(test);
      expect(test).toBeLessThan(pkg);
      expect(pkg).toBeLessThan(closedLoop);
      expect(closedLoop).toBeLessThan(build);
      expect(build).toBeLessThan(smoke);
    }
  });
});
