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
