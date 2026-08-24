import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadCatalog, installSkills, uninstallSkills } from "@ya-skills/core";

let rootDir: string;
let catalogDir: string;
let projectDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "yk-install-"));
  catalogDir = join(rootDir, "skills");
  projectDir = join(rootDir, "project");
  await mkdir(catalogDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

async function writeSkill(name: string, manifest: Record<string, unknown>) {
  const skillDir = join(catalogDir, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "skill.json"), JSON.stringify(manifest, null, 2));
  await writeFile(join(skillDir, "SKILL.md"), `# ${name}\n`);
}

test("installs requested skills and dependencies into every detected target", async () => {
  await mkdir(join(projectDir, ".claude", "skills"), { recursive: true });
  await mkdir(join(projectDir, ".agents", "skills"), { recursive: true });
  await writeSkill("demo-base", {
    name: "demo-base",
    description: "Base demo skill"
  });
  await writeSkill("demo-dependent", {
    name: "demo-dependent",
    description: "Dependent demo skill",
    dependsOn: ["demo-base"]
  });
  const catalog = await loadCatalog(catalogDir);

  const result = await installSkills({
    catalog,
    projectDir,
    skillNames: ["demo-dependent"]
  });

  expect(result.installed.map((skill) => skill.name)).toEqual(["demo-base", "demo-dependent"]);
  for (const target of [".claude/skills", ".agents/skills"]) {
    await expect(readFile(join(projectDir, target, "demo-base", "SKILL.md"), "utf8")).resolves.toBe(
      "# demo-base\n"
    );
    await expect(
      readFile(join(projectDir, target, "demo-dependent", "SKILL.md"), "utf8")
    ).resolves.toBe("# demo-dependent\n");
  }
});

test("overwrites an already installed skill with the catalog version", async () => {
  await writeSkill("demo-base", {
    name: "demo-base",
    description: "Base demo skill"
  });
  const installedDir = join(projectDir, ".agents", "skills", "demo-base");
  await mkdir(installedDir, { recursive: true });
  await writeFile(join(installedDir, "SKILL.md"), "# stale local copy\n");
  const catalog = await loadCatalog(catalogDir);

  const result = await installSkills({
    catalog,
    projectDir,
    skillNames: ["demo-base"]
  });

  expect(result.installed.map((skill) => skill.name)).toEqual(["demo-base"]);
  await expect(readFile(join(installedDir, "SKILL.md"), "utf8")).resolves.toBe("# demo-base\n");
});

test("removes leftover files when overwriting an installed skill", async () => {
  await writeSkill("demo-base", {
    name: "demo-base",
    description: "Base demo skill"
  });
  const installedDir = join(projectDir, ".agents", "skills", "demo-base");
  await mkdir(installedDir, { recursive: true });
  await writeFile(join(installedDir, "SKILL.md"), "# stale local copy\n");
  await writeFile(join(installedDir, "local-note.md"), "do not keep me\n");
  const catalog = await loadCatalog(catalogDir);

  await installSkills({
    catalog,
    projectDir,
    skillNames: ["demo-base"]
  });

  await expect(readFile(join(installedDir, "local-note.md"), "utf8")).rejects.toThrow();
});

test("uninstalls requested skills from every existing target without removing dependencies", async () => {
  await mkdir(join(projectDir, ".claude", "skills"), { recursive: true });
  await mkdir(join(projectDir, ".agents", "skills"), { recursive: true });
  await writeSkill("demo-base", {
    name: "demo-base",
    description: "Base demo skill"
  });
  await writeSkill("demo-dependent", {
    name: "demo-dependent",
    description: "Dependent demo skill",
    dependsOn: ["demo-base"]
  });
  const catalog = await loadCatalog(catalogDir);
  await installSkills({
    catalog,
    projectDir,
    skillNames: ["demo-dependent"]
  });

  const result = await uninstallSkills({
    projectDir,
    skillNames: ["demo-dependent"]
  });

  expect(result.removed).toEqual(["demo-dependent"]);
  for (const target of [".claude/skills", ".agents/skills"]) {
    await expect(readFile(join(projectDir, target, "demo-base", "SKILL.md"), "utf8")).resolves.toBe(
      "# demo-base\n"
    );
    await expect(
      readFile(join(projectDir, target, "demo-dependent", "SKILL.md"), "utf8")
    ).rejects.toThrow();
  }
});

test("fails loudly when uninstalling a skill that is not installed", async () => {
  await mkdir(join(projectDir, ".agents", "skills"), { recursive: true });

  await expect(
    uninstallSkills({
      projectDir,
      skillNames: ["missing"]
    })
  ).rejects.toThrow("Skill 'missing' is not installed in any detected target");
});
