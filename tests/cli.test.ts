import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  applySelectionEvent,
  confirmSkillsFor,
  createKeyParser,
  initialSelectionState
} from "../packages/cli/src/interactive.js";
import { formatSelectionRow, formatSkillLine, skillNameWidth } from "../packages/cli/src/skill-list.js";
import type { CatalogSkill, SkillCatalog } from "../packages/core/src/types.js";
import packageJson from "../package.json" with { type: "json" };

function checkboxCatalog(): { skills: CatalogSkill[]; catalog: SkillCatalog } {
  const skills: CatalogSkill[] = [
    { name: "alpha", description: "Base skill", dependsOn: [], functions: [], dir: "/catalog/alpha" },
    { name: "beta", description: "Dependent skill", dependsOn: ["alpha"], functions: [], dir: "/catalog/beta" }
  ];
  return { skills, catalog: { skills, byName: new Map(skills.map((skill) => [skill.name, skill])) } };
}

async function runYk(
  args: string[],
  env: Record<string, string | undefined> = {},
  options: { cwd?: string } = {}
) {
  const process = Bun.spawn(["bun", resolve("packages/cli/src/cli.ts"), ...args], {
    cwd: options.cwd ?? resolve("."),
    env: {
      ...Bun.env,
      ...env
    },
    stderr: "pipe",
    stdout: "pipe"
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited
  ]);

  return { stdout, stderr, exitCode };
}

test("yk list discovers plan-jury in the root catalog", async () => {
  const result = await runYk(["list"]);

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toMatch(/^plan-jury\s/m);
});

test("yk list prints each skill on one aligned line so names stay scannable", async () => {
  const catalogDir = await mkdtemp(join(tmpdir(), "yk-list-catalog-"));

  try {
    for (const skill of [
      { name: "alpha", description: "Base skill" },
      { name: "beta", description: "Dependent skill", dependsOn: ["alpha"] }
    ]) {
      const skillDir = join(catalogDir, skill.name);
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, "skill.json"), JSON.stringify(skill, null, 2));
      await writeFile(join(skillDir, "SKILL.md"), `# ${skill.name}\n`);
    }

    const result = await runYk(["list"], { YA_SKILLS_CATALOG_DIR: catalogDir });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(["alpha  Base skill", "beta   Dependent skill · alpha", ""].join("\n"));
  } finally {
    await rm(catalogDir, { recursive: true, force: true });
  }
});

test("yk exposes conventional help flags", async () => {
  for (const flag of ["-h", "--help"]) {
    const result = await runYk([flag]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("-v, --version");
  }
});

test("yk exposes conventional version flags", async () => {
  for (const flag of ["-v", "--version"]) {
    const result = await runYk([flag]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe(packageJson.version);
  }
});

test("yk install -g uses the user-level default target", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "yk-global-home-"));

  try {
    const result = await runYk(["install", "-g", "coding-recon"], { HOME: homeDir });
    const target = join(homeDir, ".agents", "skills", "coding-recon");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`Targets: ${join(homeDir, ".agents", "skills")}`);
    expect((await stat(target)).isDirectory()).toBe(true);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("yk install --global uses every existing user-level target", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "yk-global-home-"));
  const targets = [join(homeDir, ".claude", "skills"), join(homeDir, ".agents", "skills")];

  try {
    await Promise.all(targets.map((target) => mkdir(target, { recursive: true })));

    const result = await runYk(["install", "coding-recon", "--global"], { HOME: homeDir });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    for (const target of targets) {
      expect((await stat(join(target, "coding-recon"))).isDirectory()).toBe(true);
    }
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("yk uninstall -g removes a user-level skill without touching the current repository", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "yk-global-home-"));
  const projectDir = await mkdtemp(join(tmpdir(), "yk-local-project-"));

  try {
    const localInstall = await runYk(["install", "coding-recon"], { HOME: homeDir }, { cwd: projectDir });
    const globalInstall = await runYk(["install", "-g", "coding-recon"], { HOME: homeDir }, { cwd: projectDir });
    expect(localInstall.exitCode).toBe(0);
    expect(globalInstall.exitCode).toBe(0);

    const result = await runYk(["uninstall", "-g", "coding-recon"], { HOME: homeDir }, { cwd: projectDir });
    const homeSkill = join(homeDir, ".agents", "skills", "coding-recon");
    const projectSkill = join(projectDir, ".agents", "skills", "coding-recon");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`Targets: ${join(homeDir, ".agents", "skills")}`);
    await expect(stat(homeSkill)).rejects.toThrow();
    expect((await stat(projectSkill)).isDirectory()).toBe(true);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("yk uninstall --global removes from every existing user-level target", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "yk-global-home-"));
  const projectDir = await mkdtemp(join(tmpdir(), "yk-local-project-"));
  const targets = [join(homeDir, ".claude", "skills"), join(homeDir, ".agents", "skills")];

  try {
    await Promise.all(targets.map((target) => mkdir(target, { recursive: true })));
    const installResult = await runYk(["install", "coding-recon", "--global"], { HOME: homeDir }, { cwd: projectDir });
    expect(installResult.exitCode).toBe(0);

    const result = await runYk(["uninstall", "coding-recon", "--global"], { HOME: homeDir }, { cwd: projectDir });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    for (const target of targets) {
      await expect(stat(join(target, "coding-recon"))).rejects.toThrow();
    }
  } finally {
    await rm(homeDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("pbench documentation matches registered cross-agent workflows", async () => {
  const [readme, english, chinese, platformDesign] = await Promise.all([
    readFile(resolve("README.md"), "utf8"),
    readFile(resolve("docs", "pbench.md"), "utf8"),
    readFile(resolve("docs", "pbench.zh-CN.md"), "utf8"),
    readFile(resolve("docs", "superpowers", "specs", "2026-06-24-pbench-platform-agnostic-design.md"), "utf8")
  ]);

  for (const document of [readme, english, chinese]) {
    expect(document).toContain("codex");
    expect(document).toContain("claude");
    expect(document).toContain("run --manual");
    expect(document).toContain("--format json");
  }
  expect(english).toContain("registered capture source");
  expect(chinese).toContain("已注册的 capture source");
  expect(english).not.toContain("Other sources require `--input");
  expect(chinese).not.toContain("其他 source 需要 `--input");
  expect(platformDesign).toContain("Status: Implemented");
  expect(platformDesign).toContain("internal canonical asset");
});

test("yk prints subcommand and function help without side effects", async () => {
  const installHelp = await runYk(["install", "-h"]);
  expect(installHelp.exitCode).toBe(0);
  expect(installHelp.stdout).toContain("yk install [options] [skill...]");
  expect(installHelp.stdout).toContain("-g, --global");

  const uninstallHelp = await runYk(["uninstall", "-h"]);
  expect(uninstallHelp.exitCode).toBe(0);
  expect(uninstallHelp.stdout).toContain("yk uninstall [options] <skill...>");
  expect(uninstallHelp.stdout).toContain("-g, --global");

  const pbenchHelp = await runYk(["pbench", "-h"]);
  expect(pbenchHelp.exitCode).toBe(0);
  expect(pbenchHelp.stdout).toContain("Actions:");
  expect(pbenchHelp.stdout).toContain("capture");

  const pbenchActionHelp = await runYk(["pbench", "capture", "--help"]);
  expect(pbenchActionHelp.exitCode).toBe(0);
  expect(pbenchActionHelp.stdout).toContain("yk pbench capture [--source codex|claude]");
  expect(pbenchActionHelp.stdout).toContain("--session-id");
});

test("yk -h lists every registered function domain", async () => {
  const result = await runYk(["-h"]);

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  for (const domain of ["pbench", "computer-use", "computer-e2e"]) {
    expect(result.stdout).toContain(domain);
  }
});

test("yk <domain> <action> -h documents the real flags each command accepts", async () => {
  const act = await runYk(["computer-use", "act", "-h"]);
  expect(act.exitCode).toBe(0);
  expect(act.stdout).toContain("--pid");
  expect(act.stdout).toContain("--click-text");
  expect(act.stdout).toContain("--observation");

  const session = await runYk(["computer-use", "session", "-h"]);
  expect(session.exitCode).toBe(0);
  expect(session.stdout).toContain("open");
  expect(session.stdout).toContain("cancel");

  const e2eRun = await runYk(["computer-e2e", "run", "-h"]);
  expect(e2eRun.exitCode).toBe(0);
  expect(e2eRun.stdout).toContain("--param");
  expect(e2eRun.stdout).toContain("--timeout-ms");

  const pbenchRun = await runYk(["pbench", "run", "-h"]);
  expect(pbenchRun.exitCode).toBe(0);
  expect(pbenchRun.stdout).toContain("--case");
  expect(pbenchRun.stdout).toContain("--agent");
  expect(pbenchRun.stdout).toContain("--manual");
});

test("commands without declared usage keep the generic [...args] fallback", async () => {
  const result = await runYk(["demo", "echo", "-h"]);

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("yk demo echo [...args]");
});

test("interactive selection rows reuse the yk list line body exactly", () => {
  const { skills } = checkboxCatalog();
  const width = skillNameWidth(skills);

  expect(formatSkillLine(skills[0]!, width, false)).toBe("alpha  Base skill");
  expect(formatSelectionRow(skills[0]!, width, { checked: false, cursor: false }, false)).toBe(
    "  [ ] alpha  Base skill"
  );
  expect(formatSelectionRow(skills[1]!, width, { checked: true, cursor: true }, false)).toBe(
    "❯ [x] beta   Dependent skill · alpha"
  );
});

test("selection state machine toggles, moves, submits, and cancels", () => {
  const { skills } = checkboxCatalog();

  const space = applySelectionEvent(skills, initialSelectionState(skills), { kind: "space" });
  if (space.kind !== "continue") throw new Error("expected continue");
  expect([...space.state.checked]).toEqual(["alpha"]);

  const afterDown = applySelectionEvent(skills, space.state, { kind: "down" });
  if (afterDown.kind !== "continue") throw new Error("expected continue");
  expect(afterDown.state.cursor).toBe(1);

  const afterSecondSpace = applySelectionEvent(skills, afterDown.state, { kind: "space" });
  if (afterSecondSpace.kind !== "continue") throw new Error("expected continue");
  expect([...afterSecondSpace.state.checked]).toEqual(["alpha", "beta"]);

  const submit = applySelectionEvent(skills, afterSecondSpace.state, { kind: "enter" });
  if (submit.kind !== "submit") throw new Error("expected submit");
  expect(submit.selected).toEqual(["alpha", "beta"]);

  const emptyEnter = applySelectionEvent(skills, initialSelectionState(skills), { kind: "enter" });
  if (emptyEnter.kind !== "continue") throw new Error("expected continue");
  expect(emptyEnter.hint).toContain("space");

  const escape = applySelectionEvent(skills, initialSelectionState(skills), { kind: "escape" });
  expect(escape.kind).toBe("cancel");
});

test("key parser turns raw stdin chunks into selection events", () => {
  const parser = createKeyParser();

  expect(parser.push(" ")).toEqual([{ kind: "space" }]);
  expect(parser.push("j")).toEqual([{ kind: "down" }]);
  expect(parser.push("k")).toEqual([{ kind: "up" }]);
  expect(parser.push("\r\r")).toEqual([{ kind: "enter" }, { kind: "enter" }]);
  expect(parser.push("\n")).toEqual([{ kind: "enter" }]);
  expect(parser.push("\x1b")).toEqual([{ kind: "escape" }]);
  expect(parser.push("\x1b[A")).toEqual([{ kind: "up" }]);
  expect(parser.push("\x1b[B")).toEqual([{ kind: "down" }]);
  expect(parser.push("x")).toEqual([]);
});

test("key parser keeps keys that share a chunk with ctrl+c", () => {
  // Bun's readline keypress parser drops a key that shares a chunk with
  // \x03; our own parser must not.
  expect(createKeyParser().push(" \x03")).toEqual([{ kind: "space" }, { kind: "interrupt" }]);

  // A lone trailing ESC is the Esc key (terminals send Esc presses this way);
  // arrow sequences arrive complete in one chunk.
  expect(createKeyParser().push("\x1b\x1b[B")).toEqual([{ kind: "escape" }, { kind: "down" }]);
  expect(createKeyParser().push("\x1b[")).toEqual([]); // partial arrow held
  const held = createKeyParser();
  held.push("\x1b[");
  expect(held.push("B")).toEqual([{ kind: "down" }]);
});

test("confirm list expands selected skills with their dependencies in install order", () => {
  const { catalog } = checkboxCatalog();

  expect(confirmSkillsFor(catalog, ["beta"]).map((skill) => skill.name)).toEqual(["alpha", "beta"]);
});

test("yk install without arguments still fails cleanly when stdin is not interactive", async () => {
  const result = await runYk(["install"]);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("yk install requires skill names when stdin is not interactive");
});
