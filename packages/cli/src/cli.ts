#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { installSkills, loadCatalog, uninstallSkills, type FunctionCommand, type SkillCatalog } from "@ya-skills/core";
import { createCliFunctionRegistry } from "./function-registry.js";
import packageJson from "../../../package.json" with { type: "json" };

async function main(argv: string[]) {
  const [command, ...args] = argv;

  if (!command || isHelpFlag(command)) {
    printHelp();
    return;
  }

  if (isVersionFlag(command)) {
    printVersion();
    return;
  }

  if (command === "list") {
    if (args.some(isHelpFlag)) {
      printListHelp();
      return;
    }
    if (args.length > 0) {
      throw new Error("yk list does not accept arguments");
    }
    await listSkills();
    return;
  }

  if (command === "install") {
    if (args.some(isHelpFlag)) {
      printInstallHelp();
      return;
    }
    const parsed = parseGlobalSkillArgs(args);
    await installCommand(parsed.skillNames, resolveSkillRoot(parsed.globally));
    return;
  }

  if (command === "uninstall") {
    if (args.some(isHelpFlag)) {
      printUninstallHelp();
      return;
    }
    const parsed = parseGlobalSkillArgs(args);
    await uninstallCommand(parsed.skillNames, resolveSkillRoot(parsed.globally));
    return;
  }

  const [action, ...functionArgs] = args;
  const registry = createCliFunctionRegistry();
  if (isHelpFlag(action ?? "")) {
    printDomainHelp(command, registry.list());
    return;
  }
  if (!action) {
    throw new Error(`Missing action for function domain '${command}'`);
  }
  if (functionArgs.some(isHelpFlag)) {
    printFunctionHelp(command, action, registry.list());
    return;
  }

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

async function installCommand(skillNames: string[], projectDir: string) {
  const catalog = await loadDefaultCatalog();
  const selected = skillNames.length > 0 ? skillNames : await promptForSkills(catalog);
  if (selected.length === 0) {
    throw new Error("No skills selected");
  }

  const result = await installSkills({
    catalog,
    projectDir,
    skillNames: selected
  });

  console.log(`Installed: ${result.installed.map((skill) => skill.name).join(", ")}`);
  console.log(`Targets: ${result.targets.join(", ")}`);
}

async function uninstallCommand(skillNames: string[], projectDir: string) {
  if (skillNames.length === 0) {
    throw new Error("yk uninstall requires at least one skill name");
  }

  const result = await uninstallSkills({
    projectDir,
    skillNames
  });

  console.log(`Uninstalled: ${result.removed.join(", ")}`);
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
  const envCatalogDir = process.env.YA_SKILLS_CATALOG_DIR?.trim();
  return [
    ...(envCatalogDir ? [envCatalogDir] : []),
    join(here, "..", "..", "..", "skills"),
    join(process.cwd(), "skills")
  ];
}

function printHelp() {
  console.log(`yk

Usage:
  yk [options]
  yk <command> [args]

Options:
  -h, --help       Show help.
  -v, --version    Show version.

Commands:
  yk list
  yk install [options] [skill...]
  yk uninstall [options] <skill...>
  yk <domain> <action> [...args]
`);
}

function printListHelp() {
  console.log(`yk list

Usage:
  yk list

List skills in the active catalog.
`);
}

function printInstallHelp() {
  console.log(`yk install

Usage:
  yk install [options] [skill...]

Options:
  -g, --global    Install into user-level skill targets.

Install selected skills into this repository by default. If no skills are provided, yk prompts interactively.
`);
}

function printUninstallHelp() {
  console.log(`yk uninstall

Usage:
  yk uninstall [options] <skill...>

Options:
  -g, --global    Uninstall from user-level skill targets.

Remove selected skills from existing .claude/skills and .agents/skills targets in this repository by default.
`);
}

function printDomainHelp(domain: string, commands: FunctionCommand[]) {
  const matches = commands.filter((command) => command.domain === domain);
  if (matches.length === 0) {
    throw new Error(`Unknown function domain: ${domain}`);
  }

  console.log(`yk ${domain}

Usage:
  yk ${domain} <action> [...args]

Actions:
${matches.map((command) => `  ${command.action.padEnd(16)} ${command.description}`).join("\n")}
`);
}

function printFunctionHelp(domain: string, action: string, commands: FunctionCommand[]) {
  const command = commands.find((candidate) => candidate.domain === domain && candidate.action === action);
  if (!command) {
    throw new Error(`Unknown function command: ${domain} ${action}`);
  }

  console.log(`yk ${domain} ${action}

Usage:
  yk ${domain} ${action} [...args]

${command.description}
`);
}

function printVersion() {
  console.log(packageJson.version);
}

function isHelpFlag(value: string): boolean {
  return value === "--help" || value === "-h";
}

function isVersionFlag(value: string): boolean {
  return value === "--version" || value === "-v";
}

function parseGlobalSkillArgs(args: string[]): { skillNames: string[]; globally: boolean } {
  return {
    skillNames: args.filter((arg) => !isGlobalFlag(arg)),
    globally: args.some(isGlobalFlag)
  };
}

function resolveSkillRoot(globally: boolean): string {
  return globally ? homedir() : process.cwd();
}

function isGlobalFlag(value: string): boolean {
  return value === "--global" || value === "-g";
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
