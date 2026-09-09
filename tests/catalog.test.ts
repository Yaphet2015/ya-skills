import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  expect(designGrill?.description).toContain("stress-test");
  expect(designGrill?.functions).toEqual([]);
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

test("root catalog exposes the show-pr skill as manual-only", async () => {
  const catalog = await loadCatalog(resolve("skills"));
  const showPr = catalog.byName.get("show-pr");

  expect(showPr?.description).toMatch(/^Use only when the user explicitly invokes/);
  expect(showPr?.description).toMatch(/never triggers implicitly/);
  expect(showPr?.functions).toEqual([]);

  const skill = await readFile(resolve("skills", "show-pr", "SKILL.md"), "utf8");
  expect(skill).toContain("disable-model-invocation: true");
  expect(skill).toContain("Invocation Gate");
  expect(skill).not.toContain(".logoscode");
  expect(skill).not.toContain("pr-lens");
});

test("show-pr tools validate and build offline", async () => {
  const skillDir = resolve("skills", "show-pr");
  const example = join(skillDir, "references", "example.graph.json");

  const validate = Bun.spawn(["node", join(skillDir, "tools", "validate.cjs"), example], {
    stdout: "pipe",
    stderr: "pipe"
  });
  const [validateOut, , validateCode] = await Promise.all([
    new Response(validate.stdout).text(),
    new Response(validate.stderr).text(),
    validate.exited
  ]);
  expect(validateCode).toBe(0);
  expect(validateOut).toContain("VALID");

  const outDir = await mkdtemp(join(tmpdir(), "yk-show-pr-"));
  const outFile = join(outDir, "report.html");
  const build = Bun.spawn(["node", join(skillDir, "tools", "build-report.cjs"), example, outFile], {
    stdout: "pipe",
    stderr: "pipe"
  });
  const [, buildErr, buildCode] = await Promise.all([
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
    build.exited
  ]);
  expect(buildErr).toBe("");
  expect(buildCode).toBe(0);
  const html = await readFile(outFile, "utf8");
  expect(html).toContain("<!doctype html>");
  await rm(outDir, { recursive: true, force: true });
});

async function buildExampleClone(mutate?: (doc: Record<string, unknown>) => void) {
  const skillDir = resolve("skills", "show-pr");
  const example = join(skillDir, "references", "example.graph.json");
  const doc = JSON.parse(await readFile(example, "utf8"));
  if (mutate) mutate(doc);
  const outDir = await mkdtemp(join(tmpdir(), "yk-show-pr-clone-"));
  const docFile = join(outDir, "doc.json");
  // evidence paths resolve relative to the document, so copy the real file next to it
  const evidenceDir = join(outDir, "evidence");
  await mkdir(evidenceDir, { recursive: true });
  await Bun.write(
    join(evidenceDir, "batch-result.png"),
    Bun.file(join(skillDir, "references", "evidence", "batch-result.png"))
  );
  await Bun.write(docFile, JSON.stringify(doc));
  const outFile = join(outDir, "report.html");
  const build = Bun.spawn(["node", join(skillDir, "tools", "build-report.cjs"), docFile, outFile], {
    stdout: "pipe",
    stderr: "pipe"
  });
  const [, buildErr, buildCode] = await Promise.all([
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
    build.exited
  ]);
  const html = await readFile(outFile, "utf8");
  return { outDir, outFile, docFile, html, buildErr, buildCode };
}

test("show-pr report embeds evidence and renders mermaid from the example document", async () => {
  const { html, buildErr, buildCode, outDir } = await buildExampleClone();

  expect(buildErr).toBe("");
  expect(buildCode).toBe(0);
  expect(html).toContain("data:image/png;base64,");
  expect(html).toContain("stateDiagram-v2");
  expect(html).toContain("mermaid.initialize");
  expect(html).toContain("测试覆盖");
  expect(html).toContain("建议手动测试");
  expect(html).toContain("设计决策");
  expect(html).not.toContain("测试日志");
  await rm(outDir, { recursive: true, force: true });
});

test("show-pr report omits the mermaid bundle when the document has no mermaid", async () => {
  const { html, buildCode, outDir } = await buildExampleClone((doc) => {
    doc.mermaid = [];
  });

  expect(buildCode).toBe(0);
  expect(html).toContain("<!doctype html>");
  expect(html).not.toContain("mermaid.initialize");
  await rm(outDir, { recursive: true, force: true });
});

test("show-pr validator rejects missing evidence files and unlisted design choices", async () => {
  const skillDir = resolve("skills", "show-pr");
  const example = JSON.parse(await readFile(join(skillDir, "references", "example.graph.json"), "utf8"));
  const outDir = await mkdtemp(join(tmpdir(), "yk-show-pr-bad-"));
  const docFile = join(outDir, "doc.json");

  const runValidate = async () => {
    const proc = Bun.spawn(["node", join(skillDir, "tools", "validate.cjs"), docFile], {
      stdout: "pipe",
      stderr: "pipe"
    });
    const [out, errText, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ]);
    return { out, errText, code };
  };

  example.evidence[0].path = "evidence/does-not-exist.png";
  await Bun.write(docFile, JSON.stringify(example));
  let result = await runValidate();
  expect(result.code).toBe(1);
  expect(result.errText).toContain("evidence");

  example.evidence[0].path = "evidence/batch-result.png";
  example.design[0].chosen = "不存在的选项";
  await Bun.write(docFile, JSON.stringify(example));
  result = await runValidate();
  expect(result.code).toBe(1);
  expect(result.errText).toContain("chosen");

  example.design[0].chosen = example.design[0].options[0].label;
  example.repro[0].result = "x".repeat(501);
  await Bun.write(docFile, JSON.stringify(example));
  result = await runValidate();
  expect(result.code).toBe(1);
  expect(result.errText).toContain("result");

  example.repro[0].result = "自动化覆盖：3 项通过";
  example.repro[3].steps = "not-an-array";
  await Bun.write(docFile, JSON.stringify(example));
  result = await runValidate();
  expect(result.code).toBe(1);
  expect(result.errText).toContain("steps");

  example.repro[3].steps = ["pnpm dev 启动应用"];
  example.repro[3].expected = "";
  await Bun.write(docFile, JSON.stringify(example));
  result = await runValidate();
  expect(result.code).toBe(1);
  expect(result.errText).toContain("expected");

  example.repro[3].expected = "POST /email/batch 恰为 4 次，且无任何单封请求。";
  example.repro[0].manual = "yes";
  await Bun.write(docFile, JSON.stringify(example));
  result = await runValidate();
  expect(result.code).toBe(1);
  expect(result.errText).toContain("manual");

  example.repro[0].manual = undefined;
  example.testSteps[0].steps = [];
  await Bun.write(docFile, JSON.stringify(example));
  result = await runValidate();
  expect(result.code).toBe(1);
  expect(result.errText).toContain("steps");

  await rm(outDir, { recursive: true, force: true });
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
  expect(stdout).toContain("homebrew-only\n  Packaged catalog skill");
  expect(stdout).not.toContain("pbench");
});
