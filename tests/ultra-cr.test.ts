import { expect, test } from "bun:test";
import { installSkills, loadCatalog } from "@ya-skills/core";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function markdownFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(path));
    else if (entry.name.endsWith(".md")) files.push(path);
  }
  return files;
}

test("pipeline installation includes portable ultra-cr assets in both skill targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "ultra-cr-install-"));
  try {
    await mkdir(join(root, ".agents/skills"), { recursive: true });
    await mkdir(join(root, ".claude/skills"), { recursive: true });
    const catalog = await loadCatalog(resolve("skills"));
    const result = await installSkills({ catalog, projectDir: root, skillNames: ["ultra-produce"] });
    expect(result.installed.map((skill) => skill.name).sort()).toEqual(["ultra-cr", "ultra-produce"]);
    for (const target of [".agents", ".claude"]) {
      const skillRoot = join(root, target, "skills/ultra-cr");
      for (const resource of [
        "SKILL.md", "references/configuration.md", "references/workflow.md",
        "references/reviewers/holistic/principal.md",
        "references/reviewers/bundled/behavior-regression/behavior-regression.md",
        "references/reviewers/bundled/java-code-smell/references/java-code-smell-checklist.md",
      ]) {
        expect((await stat(join(skillRoot, resource))).isFile()).toBe(true);
      }
      // Verify concrete bundled reference targets from the installed tree, away from source CWD.
      for (const file of await markdownFiles(skillRoot)) {
        const text = await readFile(file, "utf8");
        for (const [reference] of text.matchAll(/references\/[A-Za-z0-9_./-]+\.md/g)) {
          const relativeToPersona = join(file, "..", reference);
          const exists = await stat(join(skillRoot, reference)).catch(() => stat(relativeToPersona));
          expect(exists.isFile()).toBe(true);
        }
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
