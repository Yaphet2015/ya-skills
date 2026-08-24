import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import packageJson from "../package.json" with { type: "json" };

async function runYk(
  args: string[],
  env: Record<string, string | undefined> = {},
  options: { cwd?: string } = {}
) {
  const process = Bun.spawn(["bun", resolve("packages/cli/src/cli.ts"), ...args], {
    cwd: options.cwd ?? resolve("."),
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

test("yk uninstall -g removes a user-level skill without touching the current repository", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "yk-global-home-"));
  const projectDir = await mkdtemp(join(tmpdir(), "yk-local-project-"));

  try {
    const localInstall = await runYk(["install", "coding-recon"], { HOME: homeDir }, { cwd: projectDir });
    const globalInstall = await runYk(["install", "-g", "coding-recon"], { HOME: homeDir }, { cwd: projectDir });
    expect(localInstall.exitCode).toBe(0);
    expect(globalInstall.exitCode).toBe(0);

    const result = await runYk(["uninstall", "-g", "coding-recon"], { HOME: homeDir }, { cwd: projectDir });
    const homeSkill = join(homeDir, ".agents", "skills", "coding-recon");
    const projectSkill = join(projectDir, ".agents", "skills", "coding-recon");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`Targets: ${join(homeDir, ".agents", "skills")}`);
    await expect(stat(homeSkill)).rejects.toThrow();
    expect((await stat(projectSkill)).isDirectory()).toBe(true);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("yk uninstall --global removes from every existing user-level target", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "yk-global-home-"));
  const projectDir = await mkdtemp(join(tmpdir(), "yk-local-project-"));
  const targets = [join(homeDir, ".claude", "skills"), join(homeDir, ".agents", "skills")];

  try {
    await Promise.all(targets.map((target) => mkdir(target, { recursive: true })));
    const installResult = await runYk(["install", "coding-recon", "--global"], { HOME: homeDir }, { cwd: projectDir });
    expect(installResult.exitCode).toBe(0);

    const result = await runYk(["uninstall", "coding-recon", "--global"], { HOME: homeDir }, { cwd: projectDir });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    for (const target of targets) {
      await expect(stat(join(target, "coding-recon"))).rejects.toThrow();
    }
  } finally {
    await rm(homeDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("pbench documentation matches registered cross-agent workflows", async () => {
  const [readme, english, chinese, platformDesign] = await Promise.all([
    readFile(resolve("README.md"), "utf8"),
    readFile(resolve("docs", "pbench.md"), "utf8"),
    readFile(resolve("docs", "pbench.zh-CN.md"), "utf8"),
    readFile(resolve("docs", "superpowers", "specs", "2026-06-24-pbench-platform-agnostic-design.md"), "utf8")
  ]);

  for (const document of [readme, english, chinese]) {
    expect(document).toContain("codex");
    expect(document).toContain("claude");
    expect(document).toContain("run --manual");
    expect(document).toContain("--format json");
  }
  expect(english).toContain("registered capture source");
  expect(chinese).toContain("已注册的 capture source");
  expect(english).not.toContain("Other sources require `--input");
  expect(chinese).not.toContain("其他 source 需要 `--input");
  expect(platformDesign).toContain("Status: Implemented");
  expect(platformDesign).toContain("internal canonical asset");
});

test("yk prints subcommand and function help without side effects", async () => {
  const installHelp = await runYk(["install", "-h"]);
  expect(installHelp.exitCode).toBe(0);
  expect(installHelp.stdout).toContain("yk install [options] [skill...]");
  expect(installHelp.stdout).toContain("-g, --global");

  const uninstallHelp = await runYk(["uninstall", "-h"]);
  expect(uninstallHelp.exitCode).toBe(0);
  expect(uninstallHelp.stdout).toContain("yk uninstall [options] <skill...>");
  expect(uninstallHelp.stdout).toContain("-g, --global");

  const pbenchHelp = await runYk(["pbench", "-h"]);
  expect(pbenchHelp.exitCode).toBe(0);
  expect(pbenchHelp.stdout).toContain("Actions:");
  expect(pbenchHelp.stdout).toContain("capture");

  const pbenchActionHelp = await runYk(["pbench", "capture", "--help"]);
  expect(pbenchActionHelp.exitCode).toBe(0);
  expect(pbenchActionHelp.stdout).toContain("yk pbench capture [...args]");
});
