import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { installSkills, loadCatalog } from "@ya-skills/core";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("produce-pipeline process contracts stay desktop-free", () => {
  const result = Bun.spawnSync(["python3", "tests/produce_pipeline_test.py"], {
    cwd: resolve("."),
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stdout.toString() + result.stderr.toString());
  }
  expect(result.exitCode).toBe(0);
}, 30000);

test("produce-pipeline installs executable helpers and referenced role contracts", async () => {
  const catalog = await loadCatalog(resolve("skills"));
  const root = await mkdtemp(join(tmpdir(), "produce-pipeline-install-"));
  try {
    const skill = catalog.byName.get("produce-pipeline");
    expect(skill).toBeDefined();
    await installSkills({ catalog, skillNames: ["produce-pipeline"], projectDir: root });
    for (const file of ["SKILL.md", "scripts/pipeline.py", "references/protocol.md", "references/roles.md", "references/hooks.md", "references/execution.md", "references/builder-task.md"]) {
      expect(await readFile(join(root, ".agents/skills/produce-pipeline", file), "utf8"))
        .toBe(await readFile(join("skills/produce-pipeline", file), "utf8"));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
