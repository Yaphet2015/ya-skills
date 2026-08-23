import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { loadCatalog, resolveSkillInstallOrder } from "@ya-skills/core";

let catalogDir: string;

beforeEach(async () => {
  catalogDir = await mkdtemp(join(tmpdir(), "yk-catalog-"));
});

afterEach(async () => {
  await rm(catalogDir, { recursive: true, force: true });
});

async function writeSkill(name: string, manifest: Record<string, unknown>) {
  const skillDir = join(catalogDir, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "skill.json"), JSON.stringify(manifest, null, 2));
  await writeFile(join(skillDir, "SKILL.md"), `# ${name}\n`);
}

test("loads valid skill manifests from a local catalog", async () => {
  await writeSkill("demo-base", {
    name: "demo-base",
    description: "Base demo skill"
  });
  await writeSkill("demo-dependent", {
    name: "demo-dependent",
    description: "Dependent demo skill",
    dependsOn: ["demo-base"],
    functions: [{ domain: "demo", action: "echo" }]
  });

  const catalog = await loadCatalog(catalogDir);

  expect(catalog.skills.map((skill) => skill.name)).toEqual(["demo-base", "demo-dependent"]);
  expect(catalog.byName.get("demo-dependent")?.dependsOn).toEqual(["demo-base"]);
  expect(catalog.byName.get("demo-dependent")?.functions).toEqual([
    { domain: "demo", action: "echo" }
  ]);
});

test("fails loudly when a skill manifest name does not match its directory", async () => {
  await writeSkill("demo-base", {
    name: "wrong-name",
    description: "Invalid demo skill"
  });

  await expect(loadCatalog(catalogDir)).rejects.toThrow(
    "skill.json name 'wrong-name' must match directory 'demo-base'"
  );
});

test("resolves dependencies before requested skills", async () => {
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

  const ordered = resolveSkillInstallOrder(catalog, ["demo-dependent"]);

  expect(ordered.map((skill) => skill.name)).toEqual(["demo-base", "demo-dependent"]);
});

test("fails loudly when dependencies contain a cycle", async () => {
  await writeSkill("a", {
    name: "a",
    description: "Skill A",
    dependsOn: ["b"]
  });
  await writeSkill("b", {
    name: "b",
    description: "Skill B",
    dependsOn: ["a"]
  });
  const catalog = await loadCatalog(catalogDir);

  expect(() => resolveSkillInstallOrder(catalog, ["a"])).toThrow(
    "Skill dependency cycle detected: a -> b -> a"
  );
});

test("root catalog exposes the pbench skill and its yk function refs", async () => {
  const catalog = await loadCatalog(resolve("skills"));
  const pbench = catalog.byName.get("pbench");

  expect(pbench?.description).toContain("benchmark");
  expect(pbench?.functions).toEqual([
    { domain: "pbench", action: "capture" },
    { domain: "pbench", action: "validate" },
    { domain: "pbench", action: "export-replay" },
    { domain: "pbench", action: "run" },
    { domain: "pbench", action: "start" },
    { domain: "pbench", action: "finish" },
    { domain: "pbench", action: "finalize" },
    { domain: "pbench", action: "workspace-init" },
    { domain: "pbench", action: "project-link" }
  ]);
});

test("root catalog does not expose the internal pbench runner", async () => {
  const catalog = await loadCatalog(resolve("skills"));

  expect(catalog.byName.has("pbench-runner")).toBe(false);
});

test("root catalog exposes the video-transcript skill", async () => {
  const catalog = await loadCatalog(resolve("skills"));
  const videoTranscript = catalog.byName.get("video-transcript");

  expect(videoTranscript?.description).toContain("transcript");
  expect(videoTranscript?.functions).toEqual([]);
});

test("root catalog exposes the design-grill skill", async () => {
  const catalog = await loadCatalog(resolve("skills"));
  const designGrill = catalog.byName.get("design-grill");

  expect(designGrill?.description).toContain("stress-test");
  expect(designGrill?.functions).toEqual([]);
});

test("root catalog exposes the a-share-data skill", async () => {
  const catalog = await loadCatalog(resolve("skills"));
  const aShareData = catalog.byName.get("a-share-data");

  expect(aShareData?.description).toContain("A-share");
  expect(aShareData?.functions).toEqual([]);
});

test("root catalog does not expose demo-only skills", async () => {
  const catalog = await loadCatalog(resolve("skills"));

  expect(catalog.byName.has("demo-base")).toBe(false);
  expect(catalog.byName.has("demo-dependent")).toBe(false);
});

test("yk list prefers YA_SKILLS_CATALOG_DIR for packaged installs", async () => {
  await writeSkill("homebrew-only", {
    name: "homebrew-only",
    description: "Packaged catalog skill"
  });

  const process = Bun.spawn(["bun", "packages/cli/src/cli.ts", "list"], {
    cwd: resolve("."),
    env: {
      ...Bun.env,
      YA_SKILLS_CATALOG_DIR: catalogDir
    },
    stderr: "pipe",
    stdout: "pipe"
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited
  ]);

  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  expect(stdout).toContain("homebrew-only - Packaged catalog skill");
  expect(stdout).not.toContain("pbench");
});
