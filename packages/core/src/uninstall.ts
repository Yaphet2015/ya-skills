import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { detectExistingSkillTargets } from "./targets.js";

export type UninstallSkillsOptions = {
  projectDir: string;
  skillNames: string[];
};

export type UninstallSkillsResult = {
  targets: string[];
  removed: string[];
};

export async function uninstallSkills(options: UninstallSkillsOptions): Promise<UninstallSkillsResult> {
  const targets = await detectExistingSkillTargets(options.projectDir);
  if (targets.length === 0) {
    throw new Error(`No skill targets found in ${options.projectDir}`);
  }

  const removed = [];
  for (const skillName of options.skillNames) {
    const existingPaths = [];
    for (const target of targets) {
      const skillPath = join(target, skillName);
      if (await directoryExists(skillPath)) {
        existingPaths.push(skillPath);
      }
    }

    if (existingPaths.length === 0) {
      throw new Error(`Skill '${skillName}' is not installed in any detected target`);
    }

    for (const skillPath of existingPaths) {
      await rm(skillPath, { recursive: true, force: false });
    }
    removed.push(skillName);
  }

  return { targets, removed };
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isDirectory();
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
