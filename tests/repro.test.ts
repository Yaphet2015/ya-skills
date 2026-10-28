import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installSkills, loadCatalog } from "@ya-skills/core";

const script = resolve("skills/repro/scripts/repro-scan.mjs");
let repo: string;

async function run(command: string[], cwd = repo) {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited
  ]);
  return { stdout, stderr, code };
}

async function git(...args: string[]) {
  const result = await run(["git", ...args]);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout.trim();
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "yk-repro-"));
  await git("init", "-b", "main");
  await git("config", "user.email", "repro@example.test");
  await git("config", "user.name", "Repro Test");
  for (const file of ["committed.ts", "staged.ts", "working.ts", "deleted.ts", "old name.ts"]) {
    await writeFile(join(repo, file), `${file}\n`);
  }
  await writeFile(join(repo, ".gitignore"), "ignored/\n");
  await git("add", ".");
  await git("commit", "-m", "baseline");
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

test("repro inventory includes all layers, renames, deletions and unusual untracked paths", async () => {
  const base = await git("rev-parse", "HEAD");
  await git("checkout", "-b", "feature");
  await writeFile(join(repo, "committed.ts"), "changed\n");
  await git("mv", "old name.ts", "new name.ts");
  await git("rm", "deleted.ts");
  await git("add", ".");
  await git("commit", "-m", "feature changes");
  await writeFile(join(repo, "staged.ts"), "staged\n");
  await git("add", "staged.ts");
  await writeFile(join(repo, "staged.ts"), "working after stage\n");
  await writeFile(join(repo, "working.ts"), "working\n");
  const unusual = "new\tfile\n中文.ts";
  await writeFile(join(repo, unusual), "new\n");
  await mkdir(join(repo, "ignored"));
  await writeFile(join(repo, "ignored", "secret.txt"), "ignored\n");
  await mkdir(join(repo, "subdir"));
  const before = await git("status", "--porcelain=v1", "-z");

  const result = await run(["node", script, "--repo", join(repo, "subdir"), "--base", "main"]);
  expect(result.code, result.stderr).toBe(0);
  const inventory = JSON.parse(result.stdout);
  expect(inventory.root).toBe(await realpath(repo));
  expect(inventory.baseCommit).toBe(base);
  expect(inventory.mergeBase).toBe(base);
  expect(inventory.branch).toBe("feature");
  expect(inventory.files).toEqual([
    { path: "committed.ts", changes: [{ layer: "committed", status: "M" }] },
    { path: "deleted.ts", changes: [{ layer: "committed", status: "D" }] },
    { path: unusual, changes: [{ layer: "untracked", status: "?" }] },
    { path: "new name.ts", changes: [{ layer: "committed", status: "A" }] },
    { path: "old name.ts", changes: [{ layer: "committed", status: "D" }] },
    { path: "staged.ts", changes: [{ layer: "staged", status: "M" }, { layer: "unstaged", status: "M" }] },
    { path: "working.ts", changes: [{ layer: "unstaged", status: "M" }] }
  ]);
  expect(await git("status", "--porcelain=v1", "-z")).toBe(before);
});

test("repro uses merge-base so target-only commits do not become feature changes", async () => {
  const base = await git("rev-parse", "HEAD");
  await git("checkout", "-b", "feature");
  await writeFile(join(repo, "feature.ts"), "feature\n");
  await git("add", ".");
  await git("commit", "-m", "feature");
  await git("checkout", "main");
  await writeFile(join(repo, "target-only.ts"), "target\n");
  await git("add", ".");
  await git("commit", "-m", "target advances");
  const target = await git("rev-parse", "HEAD");
  await git("checkout", "--detach", "feature");

  const result = await run(["node", script, "--base", "main"]);
  expect(result.code, result.stderr).toBe(0);
  const inventory = JSON.parse(result.stdout);
  expect(inventory.baseCommit).toBe(target);
  expect(inventory.mergeBase).toBe(base);
  expect(inventory.branch).toBeNull();
  expect(inventory.files.map((file: { path: string }) => file.path)).toEqual(["feature.ts"]);
});

test("repro fails with no inventory when the comparison base is absent or invalid", async () => {
  for (const args of [[], ["--base", "missing"], ["--base", "--all"], ["--base", "HEAD", "--unknown"]]) {
    const result = await run(["node", script, ...args]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("repro-scan:");
  }
});

test("repro installs its scanner and references into both supported skill targets", async () => {
  const catalog = await loadCatalog(resolve("skills"));
  expect(catalog.byName.get("repro")?.functions).toEqual([]);
  await mkdir(join(repo, ".agents", "skills"), { recursive: true });
  await mkdir(join(repo, ".claude", "skills"), { recursive: true });
  await installSkills({ catalog, skillNames: ["repro"], projectDir: repo });
  for (const target of [".agents", ".claude"]) {
    const installed = join(repo, target, "skills", "repro");
    for (const file of ["SKILL.md", "references/surfaces.md", "references/template.md", "references/mock-contract.md"]) {
      expect(await readFile(join(installed, file), "utf8")).toBe(await readFile(resolve("skills/repro", file), "utf8"));
    }
    const result = await run(["node", join(installed, "scripts/repro-scan.mjs"), "--base", "HEAD"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).head).toBe(await git("rev-parse", "HEAD"));
  }
});
