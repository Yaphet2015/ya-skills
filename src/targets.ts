import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

export async function detectSkillTargets(projectDir: string): Promise<string[]> {
  const claudeTarget = join(projectDir, ".claude", "skills");
  const agentsTarget = join(projectDir, ".agents", "skills");

  const [hasClaude, hasAgents] = await Promise.all([
    directoryExists(claudeTarget),
    directoryExists(agentsTarget)
  ]);

  if (hasClaude && hasAgents) {
    return [claudeTarget, agentsTarget];
  }
  if (hasClaude) {
    return [claudeTarget];
  }
  if (hasAgents) {
    return [agentsTarget];
  }

  await mkdir(agentsTarget, { recursive: true });
  return [agentsTarget];
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
