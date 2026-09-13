import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve("scripts/update-ya-skills-formula.py");

async function updateFormula(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ya-skills-formula-"));
  const formulaPath = join(dir, "ya-skills.rb");

  try {
    await writeFile(formulaPath, source);

    const process = Bun.spawn(["python3", script, formulaPath], {
      env: {
        ...Bun.env,
        VERSION: "0.11.0",
        TAG_NAME: "v0.11.0",
        ASSET_NAME: "ya-skills-v0.11.0-macos-arm64.tar.gz",
        ASSET_SHA256: "newsha"
      },
      stderr: "pipe",
      stdout: "pipe"
    });

    const [stderr, exitCode] = await Promise.all([
      new Response(process.stderr).text(),
      process.exited
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    return await readFile(formulaPath, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("drops explicit formula version because brew audit infers it from the GitHub release URL", async () => {
  const result = await updateFormula(`class YaSkills < Formula
  url "https://github.com/Yaphet2015/ya-skills/releases/download/v0.10.0/ya-skills-v0.10.0-macos-arm64.tar.gz"
  version "0.10.0"
  sha256 "oldsha"
  license :cannot_represent

  def install
    libexec.install "yk", "runtime"
    pkgshare.install "skills"
    (bin/"yk").write_env_script libexec/"yk", YA_SKILLS_CATALOG_DIR: pkgshare/"skills"
  end

  test do
    assert_match "0.10.0", shell_output("#{bin}/yk --version")
  end
end
`);

  expect(result).not.toMatch(/^\s*version /m);
  expect(result).toContain(
    'url "https://github.com/Yaphet2015/ya-skills/releases/download/v0.11.0/ya-skills-v0.11.0-macos-arm64.tar.gz"'
  );
  expect(result).toContain('sha256 "newsha"');
  expect(result).toContain('assert_match "0.11.0", shell_output("#{bin}/yk --version")');
});

test("release-please updates the tap with the formula script instead of rewriting version", async () => {
  const workflow = await readFile(resolve(".github/workflows/release-please.yml"), "utf8");

  expect(workflow).toContain("scripts/update-ya-skills-formula.py");
  expect(workflow).not.toContain('version "{version}"');
});

test("formula fixture installs the runtime sidecar beside the yk binary", async () => {
  const formula = await readFile(resolve("tests/fixtures/ya-skills-formula.rb"), "utf8");

  // The compiled binary locates runtime/computer-use relative to its
  // realpath'd executable — Cellar libexec — so it must be installed there.
  expect(formula).toContain('libexec.install "yk", "runtime"');
  expect(formula).toContain('pkgshare.install "skills"');
  expect(formula).toContain('YA_SKILLS_CATALOG_DIR: pkgshare/"skills"');
  expect(formula).not.toContain('depends_on "node"');
});

test("updater rewrites only url/sha256/version-assert on the runtime-aware fixture", async () => {
  const result = await updateFormula(`class YaSkills < Formula
  desc "Personal skill repository and yk CLI"
  homepage "https://github.com/Yaphet2015/ya-skills"
  url "https://github.com/Yaphet2015/ya-skills/releases/download/v0.10.0/ya-skills-v0.10.0-macos-arm64.tar.gz"
  sha256 "oldsha"
  license :cannot_represent

  depends_on arch: :arm64
  depends_on :macos

  def install
    libexec.install "yk", "runtime"
    pkgshare.install "skills"
    (bin/"yk").write_env_script libexec/"yk", YA_SKILLS_CATALOG_DIR: pkgshare/"skills"
  end

  test do
    assert_match "0.10.0", shell_output("#{bin}/yk --version")
  end
end
`);

  expect(result).toContain('libexec.install "yk", "runtime"');
  expect(result).toContain(
    'url "https://github.com/Yaphet2015/ya-skills/releases/download/v0.11.0/ya-skills-v0.11.0-macos-arm64.tar.gz"'
  );
  expect(result).toContain('sha256 "newsha"');
  expect(result).not.toMatch(/^\s*version /m);
});

test("updater fails loudly on a formula without the runtime install shape", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ya-skills-formula-old-"));
  const formulaPath = join(dir, "ya-skills.rb");
  try {
    await writeFile(
      formulaPath,
      `class YaSkills < Formula
  url "https://github.com/Yaphet2015/ya-skills/releases/download/v0.10.0/ya-skills-v0.10.0-macos-arm64.tar.gz"
  sha256 "oldsha"

  def install
    libexec.install "yk"
    pkgshare.install "skills"
    (bin/"yk").write_env_script libexec/"yk", YA_SKILLS_CATALOG_DIR: pkgshare/"skills"
  end
end
`
    );

    const process = Bun.spawn(["python3", script, formulaPath], {
      env: {
        ...Bun.env,
        VERSION: "0.11.0",
        TAG_NAME: "v0.11.0",
        ASSET_NAME: "ya-skills-v0.11.0-macos-arm64.tar.gz",
        ASSET_SHA256: "newsha"
      },
      stderr: "pipe",
      stdout: "pipe"
    });

    const [stderr, exitCode] = await Promise.all([
      new Response(process.stderr).text(),
      process.exited
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('libexec.install "yk", "runtime"');
    // and the formula was left untouched
    expect(await readFile(formulaPath, "utf8")).toContain('libexec.install "yk"\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
