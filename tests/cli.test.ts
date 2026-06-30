import { expect, test } from "bun:test";
import { resolve } from "node:path";
import packageJson from "../package.json" with { type: "json" };

async function runYk(args: string[]) {
  const process = Bun.spawn(["bun", "packages/cli/src/cli.ts", ...args], {
    cwd: resolve("."),
    stderr: "pipe",
    stdout: "pipe"
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited
  ]);

  return { stdout, stderr, exitCode };
}

test("yk exposes conventional help flags", async () => {
  for (const flag of ["-h", "--help"]) {
    const result = await runYk([flag]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("-v, --version");
  }
});

test("yk exposes conventional version flags", async () => {
  for (const flag of ["-v", "--version"]) {
    const result = await runYk([flag]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe(packageJson.version);
  }
});

test("yk prints subcommand and function help without side effects", async () => {
  const installHelp = await runYk(["install", "-h"]);
  expect(installHelp.exitCode).toBe(0);
  expect(installHelp.stdout).toContain("yk install [skill...]");

  const pbenchHelp = await runYk(["pbench", "-h"]);
  expect(pbenchHelp.exitCode).toBe(0);
  expect(pbenchHelp.stdout).toContain("Actions:");
  expect(pbenchHelp.stdout).toContain("capture");

  const pbenchActionHelp = await runYk(["pbench", "capture", "--help"]);
  expect(pbenchActionHelp.exitCode).toBe(0);
  expect(pbenchActionHelp.stdout).toContain("yk pbench capture [...args]");
});
