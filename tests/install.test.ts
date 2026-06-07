import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadCatalog } from "../src/catalog.js";
import { installSkills } from "../src/install.js";

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

test("refuses to overwrite an already installed skill", async () => {
  await writeSkill("demo-base", {
    name: "demo-base",
    description: "Base demo skill"
  });
  await mkdir(join(projectDir, ".agents", "skills", "demo-base"), { recursive: true });
  const catalog = await loadCatalog(catalogDir);

  await expect(
    installSkills({
      catalog,
      projectDir,
      skillNames: ["demo-base"]
    })
  ).rejects.toThrow("Skill 'demo-base' already exists at");
});
