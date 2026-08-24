import { cp, mkdir, rm } from "node:fs/promises";
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
    await mkdir(target, { recursive: true });
    for (const skill of installed) {
      const destination = join(target, skill.name);
      await rm(destination, { recursive: true, force: true });
      await cp(skill.dir, destination, { recursive: true });
    }
  }

  return { targets, installed };
}
