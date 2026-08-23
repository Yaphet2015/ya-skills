import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import packageJson from "../package.json" with { type: "json" };

async function runYk(args: string[], env: Record<string, string | undefined> = {}) {
  const process = Bun.spawn(["bun", "packages/cli/src/cli.ts", ...args], {
    cwd: resolve("."),
    env: {
      ...Bun.env,
      ...env
    },
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

test("yk install -g uses the user-level default target", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "yk-global-home-"));

  try {
    const result = await runYk(["install", "-g", "coding-recon"], { HOME: homeDir });
    const target = join(homeDir, ".agents", "skills", "coding-recon");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`Targets: ${join(homeDir, ".agents", "skills")}`);
    expect((await stat(target)).isDirectory()).toBe(true);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("yk install --global uses every existing user-level target", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "yk-global-home-"));
  const targets = [join(homeDir, ".claude", "skills"), join(homeDir, ".agents", "skills")];

  try {
    await Promise.all(targets.map((target) => mkdir(target, { recursive: true })));

    const result = await runYk(["install", "coding-recon", "--global"], { HOME: homeDir });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    for (const target of targets) {
      expect((await stat(join(target, "coding-recon"))).isDirectory()).toBe(true);
    }
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("yk prints subcommand and function help without side effects", async () => {
  const installHelp = await runYk(["install", "-h"]);
  expect(installHelp.exitCode).toBe(0);
  expect(installHelp.stdout).toContain("yk install [options] [skill...]");
  expect(installHelp.stdout).toContain("-g, --global");

  const pbenchHelp = await runYk(["pbench", "-h"]);
  expect(pbenchHelp.exitCode).toBe(0);
  expect(pbenchHelp.stdout).toContain("Actions:");
  expect(pbenchHelp.stdout).toContain("capture");

  const pbenchActionHelp = await runYk(["pbench", "capture", "--help"]);
  expect(pbenchActionHelp.exitCode).toBe(0);
  expect(pbenchActionHelp.stdout).toContain("yk pbench capture [...args]");
});
