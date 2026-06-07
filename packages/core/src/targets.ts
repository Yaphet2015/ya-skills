import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

export async function detectSkillTargets(projectDir: string): Promise<string[]> {
  const targets = await detectExistingSkillTargets(projectDir);
  if (targets.length > 0) {
    return targets;
  }

  const agentsTarget = join(projectDir, ".agents", "skills");
  await mkdir(agentsTarget, { recursive: true });
  return [agentsTarget];
}

export async function detectExistingSkillTargets(projectDir: string): Promise<string[]> {
  const claudeTarget = join(projectDir, ".claude", "skills");
  const agentsTarget = join(projectDir, ".agents", "skills");

  const [hasClaude, hasAgents] = await Promise.all([
    directoryExists(claudeTarget),
    directoryExists(agentsTarget)
  ]);

  const targets = [];
  if (hasClaude) {
    targets.push(claudeTarget);
  }
  if (hasAgents) {
    targets.push(agentsTarget);
  }
  return targets;
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
