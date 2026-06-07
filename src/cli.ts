#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog } from "./catalog.js";
import { createFunctionRegistry } from "./functions.js";
import { installSkills } from "./install.js";
import type { SkillCatalog } from "./types.js";

async function main(argv: string[]) {
  const [command, ...args] = argv;

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "list") {
    await listSkills();
    return;
  }

  if (command === "install") {
    await installCommand(args);
    return;
  }

  const [action, ...functionArgs] = args;
  if (!action) {
    throw new Error(`Missing action for function domain '${command}'`);
  }

  const registry = createFunctionRegistry();
  const result = await registry.run(command, action, functionArgs);
  if (result !== undefined) {
    console.log(result);
  }
}

async function listSkills() {
  const catalog = await loadDefaultCatalog();
  for (const skill of catalog.skills) {
    const dependencyText = skill.dependsOn.length > 0 ? ` (depends on ${skill.dependsOn.join(", ")})` : "";
    console.log(`${skill.name} - ${skill.description}${dependencyText}`);
  }
}

async function installCommand(skillNames: string[]) {
  const catalog = await loadDefaultCatalog();
  const selected = skillNames.length > 0 ? skillNames : await promptForSkills(catalog);
  if (selected.length === 0) {
    throw new Error("No skills selected");
  }

  const result = await installSkills({
    catalog,
    projectDir: process.cwd(),
    skillNames: selected
  });

  console.log(`Installed: ${result.installed.map((skill) => skill.name).join(", ")}`);
  console.log(`Targets: ${result.targets.join(", ")}`);
}

async function promptForSkills(catalog: SkillCatalog): Promise<string[]> {
  if (!process.stdin.isTTY) {
    throw new Error("yk install requires skill names when stdin is not interactive");
  }

  for (const [index, skill] of catalog.skills.entries()) {
    console.log(`${index + 1}. ${skill.name} - ${skill.description}`);
  }

  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question("Select skills by number or name, separated by commas: ");
    return answer
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const index = Number(item);
        if (Number.isInteger(index) && index >= 1 && index <= catalog.skills.length) {
          return catalog.skills[index - 1].name;
        }
        return item;
      });
  } finally {
    rl.close();
  }
}

async function loadDefaultCatalog(): Promise<SkillCatalog> {
  for (const dir of catalogCandidates()) {
    try {
      await readdir(dir);
      return loadCatalog(dir);
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
    }
  }
  throw new Error("Unable to locate skills catalog");
}

function catalogCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [join(here, "..", "skills"), join(here, "skills"), join(process.cwd(), "skills")];
}

function printHelp() {
  console.log(`yk

Commands:
  yk list
  yk install [skill...]
  yk <domain> <action> [...args]
`);
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
