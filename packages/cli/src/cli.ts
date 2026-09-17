#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  installSkills,
  loadCatalog,
  uninstallSkills,
  type FunctionCommand,
  type SkillCatalog
} from "@ya-skills/core";
import { runWorkerFromConfig } from "@ya-skills/functions-computer-e2e";
import { driverWorkerMain, execWorkerMain, hostMain } from "@ya-skills/computer-session";
import { selectSkillsInteractively } from "./interactive.js";
import { formatSkillLine, shouldColor, skillNameWidth } from "./skill-list.js";
import { createCliFunctionRegistry } from "./function-registry.js";
import packageJson from "../../../package.json" with { type: "json" };

async function main(argv: string[]) {
  const [command, ...args] = argv;

  // Internal e2e worker bootstrap: exactly one absolute config path, handled
  // before any public command or registry import.
  if (command === "__computer-e2e-worker") {
    const configPath = args[0];
    if (args.length !== 1 || !configPath || !configPath.startsWith("/")) {
      throw new Error("internal worker bootstrap expects exactly one absolute config path");
    }
    process.exit(await runWorkerFromConfig(configPath));
  }

  // Internal session host / worker bootstraps: same strict shape as the
  // e2e worker. No public help surface, no SDK loading before dispatch.
  if (command === "__computer-session-host" || command === "__computer-driver-worker" || command === "__computer-exec-worker") {
    const configPath = args[0];
    if (args.length !== 1 || !configPath || !isAbsolute(configPath)) {
      throw new Error(`internal ${command} bootstrap expects exactly one absolute config path`);
    }
    process.exit(
      command === "__computer-session-host"
        ? await hostMain(configPath)
        : command === "__computer-driver-worker"
          ? await driverWorkerMain(configPath)
          : await execWorkerMain(configPath)
    );
  }

  if (!command || isHelpFlag(command)) {
    printHelp(createCliFunctionRegistry().list());
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
  const nameWidth = skillNameWidth(catalog.skills);
  const color = shouldColor();
  for (const skill of catalog.skills) {
    console.log(formatSkillLine(skill, nameWidth, color));
  }
}

async function installCommand(skillNames: string[], projectDir: string) {
  const catalog = await loadDefaultCatalog();
  const selected = skillNames.length > 0 ? skillNames : await promptForSkills(catalog);

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

  const result = await selectSkillsInteractively(catalog);
  if (result.canceled) {
    console.log("yk install canceled.");
    process.exit(result.reason === "interrupt" ? 130 : 1);
  }
  return result.selected;
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

function printHelp(commands: FunctionCommand[]) {
  const domains = [...new Set(commands.map((command) => command.domain))];
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

Function domains: ${domains.join(", ")}
Run 'yk <domain> -h' to list actions, 'yk <domain> <action> -h' for usage.
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

Install selected skills into this repository by default. Without skill names on an interactive terminal, yk shows a checkbox picker over the catalog (same view as yk list): arrows move, space toggles, Enter confirms, a second Enter installs; Esc or Ctrl+C cancels.
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

  const usage = command.usage?.length
    ? command.usage.map((line) => `  ${line}`).join("\n")
    : `  yk ${domain} ${action} [...args]`;

  console.log(`yk ${domain} ${action}

Usage:
${usage}

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
