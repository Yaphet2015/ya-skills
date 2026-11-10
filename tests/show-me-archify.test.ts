import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { installSkills, loadCatalog } from "@ya-skills/core";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test.each(["show-me", "show-pr"])("installing %s preserves independently installed archify", async (skillName) => {
  const projectDir = await mkdtemp(join(tmpdir(), "yk-external-archify-"));
  directories.push(projectDir);
  const externalDir = join(projectDir, ".agents", "skills", "archify");
  await mkdir(externalDir, { recursive: true });
  const guide = "---\nname: archify\ndescription: Independently installed skill\n---\n";
  const renderer = "external renderer, maintained separately";
  await Bun.write(join(externalDir, "SKILL.md"), guide);
  await Bun.write(join(externalDir, "renderer.cjs"), renderer);

  const catalog = await loadCatalog(resolve("skills"));
  const result = await installSkills({ catalog, projectDir, skillNames: [skillName] });
  expect(result.installed.map((entry) => entry.name)).toEqual(
    skillName === "show-me" ? ["show-me"] : ["show-me", "show-pr"]
  );
  expect(catalog.byName.has("archify")).toBe(false);
  expect(await readFile(join(externalDir, "SKILL.md"), "utf8")).toBe(guide);
  expect(await readFile(join(externalDir, "renderer.cjs"), "utf8")).toBe(renderer);
});

test("legacy report commands explain the migration and preserve an existing output", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "yk-report-migration-"));
  directories.push(projectDir);
  const output = join(projectDir, "report.html");
  await Bun.write(output, "existing report");
  for (const name of ["show-me", "show-pr"]) {
    for (const command of ["build-report.cjs", "validate.cjs"]) {
      const proc = Bun.spawn([
        "node", resolve("skills", name, "tools", command),
        resolve("archive/show-me-html/show-me/references/example.graph.json"), output
      ], { stdout: "pipe", stderr: "pipe" });
      const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      expect(code).toBe(1);
      expect(stderr).toContain("archify finalize");
      expect(await readFile(output, "utf8")).toBe("existing report");
    }
  }
});
