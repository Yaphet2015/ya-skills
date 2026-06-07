import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectExistingSkillTargets, detectSkillTargets } from "@ya-skills/core";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "yk-targets-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("creates .agents/skills when a repo has no known skill target", async () => {
  const targets = await detectSkillTargets(tempDir);

  expect(targets).toEqual([join(tempDir, ".agents", "skills")]);
});

test("uses existing .claude/skills target", async () => {
  await mkdir(join(tempDir, ".claude", "skills"), { recursive: true });

  const targets = await detectSkillTargets(tempDir);

  expect(targets).toEqual([join(tempDir, ".claude", "skills")]);
});

test("uses existing .agents/skills target", async () => {
  await mkdir(join(tempDir, ".agents", "skills"), { recursive: true });

  const targets = await detectSkillTargets(tempDir);

  expect(targets).toEqual([join(tempDir, ".agents", "skills")]);
});

test("installs to both known targets when both exist", async () => {
  await mkdir(join(tempDir, ".claude", "skills"), { recursive: true });
  await mkdir(join(tempDir, ".agents", "skills"), { recursive: true });

  const targets = await detectSkillTargets(tempDir);

  expect(targets).toEqual([
    join(tempDir, ".claude", "skills"),
    join(tempDir, ".agents", "skills")
  ]);
});

test("detects existing uninstall targets without creating defaults", async () => {
  const targets = await detectExistingSkillTargets(tempDir);

  expect(targets).toEqual([]);
});
