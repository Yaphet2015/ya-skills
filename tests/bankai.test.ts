import { expect, test } from "bun:test";
import { resolve, join } from "node:path";
import { installSkills, loadCatalog } from "@ya-skills/core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

test("Bankai recovery, ownership and local registration stay desktop-free", () => {
  const result = Bun.spawnSync(["python3", "-B", "tests/bankai_workflow_test.py"], {
    cwd: resolve("."),
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stdout.toString() + result.stderr.toString());
  }
  expect(result.exitCode).toBe(0);
}, 120000);

test("Bankai installs independently and Stage reuses its runnable helper", async () => {
  const catalog = await loadCatalog(resolve("skills"));
  const root = await mkdtemp(join(tmpdir(), "bankai-catalog-install-"));
  try {
    const result = await installSkills({ catalog, skillNames: ["bankai"], projectDir: root });
    expect(result.installed.map((skill) => skill.name)).toEqual(["bankai"]);
    const stage = await installSkills({ catalog, skillNames: ["stage"], projectDir: root });
    expect(stage.installed.map((skill) => skill.name)).toEqual(["bankai", "stage"]);
    expect(await Bun.file(join(root, ".agents/skills/ultra-produce/SKILL.md")).exists()).toBe(false);
    const helper = join(root, ".agents/skills/bankai/scripts/pipeline.py");
    const help = Bun.spawnSync(["python3", "-B", helper, "--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout.toString()).toContain("Explicit Bankai execution");
    const runtime = `${root}-runtime`;
    const status = Bun.spawnSync(["python3", "-B", helper, "--repo", root, "--root", runtime, "status", "current"]);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout.toString()).registration).toBe("not registered");
    expect(await Bun.file(join(runtime, "workspaces.json")).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
