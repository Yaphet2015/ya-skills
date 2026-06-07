import { cp, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { resolveSkillInstallOrder } from "./dependencies.js";
import { detectSkillTargets } from "./targets.js";
import type { CatalogSkill, SkillCatalog } from "./types.js";

export type InstallSkillsOptions = {
  catalog: SkillCatalog;
  projectDir: string;
  skillNames: string[];
};

export type InstallSkillsResult = {
  targets: string[];
  installed: CatalogSkill[];
};

export async function installSkills(options: InstallSkillsOptions): Promise<InstallSkillsResult> {
  const installed = resolveSkillInstallOrder(options.catalog, options.skillNames);
  const targets = await detectSkillTargets(options.projectDir);

  for (const target of targets) {
    for (const skill of installed) {
      const destination = join(target, skill.name);
      if (await pathExists(destination)) {
        throw new Error(`Skill '${skill.name}' already exists at ${destination}`);
      }
    }
  }

  for (const target of targets) {
    await mkdir(target, { recursive: true });
    for (const skill of installed) {
      await cp(skill.dir, join(target, skill.name), { recursive: true });
    }
  }

  return { targets, installed };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
