import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// This acceptance file is opt-in because the compiled release artifact is not
// present in a normal source-only checkout. It performs no desktop operation:
// the matrix only installs catalog files in private temporary directories.
const optIn = process.env.YK_PERMISSIONS_INSTALL === "1";
const maybe = optIn ? test : test.skip;
const root = resolve(import.meta.dir, "..");
const bun = process.execPath;
const releaseDir = join(root, "dist/release/ya-skills");
const yk = join(releaseDir, "yk");
const sourceCli = join(root, "packages/cli/src/cli.ts");
const catalog = join(releaseDir, "skills");

function run(path: string, args: string[], cwd: string, extraEnv: Record<string, string> = {}) {
  const env = {
    ...process.env,
    PATH: "/usr/bin:/bin",
    NODE_PATH: "",
    NODE_OPTIONS: "",
    BUN_OPTIONS: "",
    YA_SKILLS_CATALOG_DIR: catalog,
    ...extraEnv
  };
  const result = spawnSync(path, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 30_000,
    killSignal: "SIGTERM",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return {
    ...result,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

maybe("source, compiled, symlink, hostile cwd, and sanitized PATH install the catalog", () => {
  expect(existsSync(yk)).toBe(true);
  expect(existsSync(catalog)).toBe(true);

  const tempRoot = mkdtempSync(join(tmpdir(), "yk-permissions-install-test-"));
  const sourceProject = join(tempRoot, "source-project");
  const compiledProject = join(tempRoot, "compiled-project");
  const hostile = join(tempRoot, "hostile-cwd");
  const linkBin = join(tempRoot, "bin");
  const linkYk = join(linkBin, "yk-link");
  for (const dir of [sourceProject, compiledProject, hostile, linkBin]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(
    join(hostile, "package.json"),
    JSON.stringify({
      name: "hostile-project",
      version: "1.0.0",
      scripts: { preinstall: "touch SENTINEL_RAN", prepare: "touch SENTINEL_RAN" },
      dependencies: { "@trycua/cua-driver": "0.0.0-fake" }
    })
  );
  symlinkSync(yk, linkYk);

  try {
    const source = run(bun, [sourceCli, "install", "computer-use"], sourceProject);
    const compiled = run(yk, ["install", "computer-use"], compiledProject);
    const symlink = run(linkYk, ["install", "computer-use"], hostile);

    for (const result of [source, compiled, symlink]) {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Installed: computer-use");
    }

    for (const target of [
      join(sourceProject, ".agents", "skills"),
      join(compiledProject, ".agents", "skills"),
      join(hostile, ".agents", "skills")
    ]) {
      expect(existsSync(join(target, "computer-use", "SKILL.md"))).toBe(true);
    }
    expect(existsSync(join(hostile, "SENTINEL_RAN"))).toBe(false);
    expect(realpathSync(linkYk)).toBe(realpathSync(yk));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
