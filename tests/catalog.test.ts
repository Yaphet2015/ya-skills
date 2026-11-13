import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { installSkills, loadCatalog, resolveSkillInstallOrder } from "@ya-skills/core";

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

test("root catalog exposes pbench as a thin capture and replay router", async () => {
  const catalog = await loadCatalog(resolve("skills"));
  const pbench = catalog.byName.get("pbench");
  const skill = await readFile(resolve("skills", "pbench", "SKILL.md"), "utf8");

  expect(pbench?.description).toMatch(/capture/i);
  expect(pbench?.description).toMatch(/run|replay|compare/i);
  expect(pbench?.functions).toEqual([]);
  expect(skill).toContain("user approval");
  expect(skill).toContain("before repair");
  expect(skill).toContain("registered source");
  expect(skill).toContain("codex");
  expect(skill).toContain("claude");
  expect(skill).not.toContain("<current-agent>");
  expect(skill).toContain("authoring-checklist.md");
  expect(skill).toContain("yk pbench run");
  expect(skill).toContain("yk pbench report");
  expect(skill).not.toContain("private/failure.md");
  expect(skill).not.toContain("private/validators/check-completion.mjs");
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

  expect(designGrill?.description.toLowerCase()).toContain("stress-test");
  expect(designGrill?.functions).toEqual([]);
});

test("root catalog exposes the eli10 skill", async () => {
  const catalog = await loadCatalog(resolve("skills"));
  const eli10 = catalog.byName.get("eli10");

  expect(eli10?.description).toContain("看不懂");
  expect(eli10?.functions).toEqual([]);
});

test("root catalog exposes the validator skill", async () => {
  const catalog = await loadCatalog(resolve("skills"));
  const validator = catalog.byName.get("validator");

  expect(validator).toBeDefined();
  expect(validator?.functions).toEqual([]);
});

test("root catalog exposes the a-share-data skill", async () => {
  const catalog = await loadCatalog(resolve("skills"));
  const aShareData = catalog.byName.get("a-share-data");

  expect(aShareData?.description).toContain("A-share");
  expect(aShareData?.functions).toEqual([]);
});

test("root catalog exposes the svg-icons skill without CLI functions", async () => {
  const catalog = await loadCatalog(resolve("skills"));
  const svgIcons = catalog.byName.get("svg-icons");

  expect(svgIcons?.description).toContain("/svg-icons");
  expect(svgIcons?.functions).toEqual([]);
});

test("root catalog skill descriptions stay short enough to scan and route", async () => {
  const catalog = await loadCatalog(resolve("skills"));

  for (const skill of catalog.skills) {
    expect(skill.description.length, skill.name).toBeLessThanOrEqual(160);
  }
});

test("root catalog exposes the ultra-simplify skill", async () => {
  const catalog = await loadCatalog(resolve("skills"));
  const ultraSimplify = catalog.byName.get("ultra-simplify");

  expect(ultraSimplify?.description).toContain("simplification");
  expect(ultraSimplify?.functions).toEqual([]);

  const skill = await readFile(resolve("skills", "ultra-simplify", "SKILL.md"), "utf8");
  expect(skill).toContain("40%");
  expect(skill).toContain("No excuses. No waiting for the user's decisions.");
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
  expect(stdout).toContain("homebrew-only  Packaged catalog skill");
  expect(stdout).not.toContain("pbench");
});

test("root catalog exposes the computer-use skill with its command functions", async () => {
  const catalog = await loadCatalog(resolve("skills"));
  const computerUse = catalog.byName.get("computer-use");

  expect(computerUse?.dependsOn).toEqual([]);
  expect(computerUse?.functions.map((f) => f.action)).toEqual([
    "doctor",
    "apps",
    "windows",
    "perceive",
    "observe",
    "zoom",
    "act",
    "batch",
    "session",
    "exec"
  ]);

  const skill = await readFile(resolve("skills", "computer-use", "SKILL.md"), "utf8");
  expect(skill).toContain("yk computer-use apps");
  expect(skill).toContain("yk computer-use windows --pid");
  expect(skill).toContain("yk computer-use perceive --pid");
  expect(skill).toContain("yk computer-use doctor");
  expect(skill).not.toContain("cowork-e2e");
  expect(skill).not.toContain("cowork_app");
  expect(skill).toContain("background");
  expect(skill).toContain("--activate");
});

test("root catalog exposes the computer-e2e skill, installable with all references", async () => {
  const catalog = await loadCatalog(resolve("skills"));
  const skill = catalog.byName.get("computer-e2e");
  expect(skill?.dependsOn).toEqual(["computer-use"]);
  expect(skill?.functions.map((f) => f.action)).toEqual(["run", "history", "report"]);

  // Install into a throwaway project and verify the full local surface.
  const project = await mkdtemp(join(tmpdir(), "yk-catalog-e2e-"));
  const result = await installSkills({ catalog, projectDir: project, skillNames: ["computer-e2e"] });
  expect(result.installed.map((s) => s.name).sort()).toEqual(["computer-e2e", "computer-use"]);

  const installed = join(project, ".agents", "skills");
  const doc = await readFile(join(installed, "computer-e2e", "SKILL.md"), "utf8");
  const api = await readFile(join(installed, "computer-e2e", "references", "api.d.ts"), "utf8");
  const example = await readFile(join(installed, "computer-e2e", "examples", "pure.e2e.ts"), "utf8");
  expect(doc).toContain("yk computer-e2e run");
  expect(doc).not.toContain("/Users/");
  expect(api).not.toContain("@ya-skills/");
  expect(api).not.toContain("@trycua/");
  expect(api).toContain("interface Suite");
  expect(api).toContain("interface CaseContext");
  expect(example).toContain("apiVersion: 1");

  // No runtime dependencies ride along, and every local reference exists.
  expect(await Bun.file(join(project, "node_modules")).exists()).toBe(false);
  for (const match of doc.matchAll(/\]\(([^)]+\.md|[^)]+\.d\.ts|[^)]+\.ts)\)/g)) {
    const target = match[1]!.replace(/^\.?\//, "");
    expect(await Bun.file(join(installed, "computer-e2e", target)).exists()).toBe(true);
  }
});
