import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  nowIso,
  pathExists,
  readJson,
  writeJson
} from "./shared.js";
import { mkdir } from "node:fs/promises";

export type WorkspaceInfo = {
  root: string;
  metadataPath: string;
};

function expandHome(path: string, home = homedir()): string {
  if (path === "~") return home;
  return path.startsWith(`~${sep}`) ? join(home, path.slice(2)) : path;
}

export function absolutePath(path: string, cwd = process.cwd(), home = homedir()): string {
  const expanded = expandHome(path, home);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

export async function initWorkspace(rootInput: string): Promise<WorkspaceInfo> {
  const root = absolutePath(rootInput);
  await Promise.all([
    mkdir(join(root, ".personal-bench"), { recursive: true }),
    mkdir(join(root, "cases"), { recursive: true }),
    mkdir(join(root, "repos"), { recursive: true })
  ]);
  const metadataPath = join(root, ".personal-bench", "workspace.json");
  const createdAt = (await pathExists(metadataPath)) ? (await readJson(metadataPath)).createdAt : nowIso();
  await writeJson(metadataPath, {
    schemaVersion: 1,
    kind: "workspace",
    workspaceRoot: root,
    createdAt,
    updatedAt: nowIso()
  });
  return { root, metadataPath };
}

export async function linkProject(projectRootInput: string, workspaceRootInput: string): Promise<string> {
  const projectRoot = absolutePath(projectRootInput);
  const workspaceRoot = absolutePath(workspaceRootInput);
  await assertWorkspace(workspaceRoot);
  const linkPath = join(projectRoot, ".personal-bench", "workspace.json");
  await writeJson(linkPath, {
    schemaVersion: 1,
    kind: "project-link",
    workspaceRoot,
    createdAt: nowIso(),
    updatedAt: nowIso()
  });
  return linkPath;
}

export async function assertWorkspace(root: string): Promise<void> {
  if (!(await pathExists(join(root, ".personal-bench", "workspace.json")))) {
    throw new Error(`Not a personal-bench workspace: ${root}`);
  }
}

export async function resolveWorkspaceRoot(
  options: { workspace?: string; cwd?: string; env?: NodeJS.ProcessEnv; home?: string; createDefault?: boolean } = {}
): Promise<string> {
  const cwd = absolutePath(options.cwd ?? process.cwd());
  const home = options.home ?? homedir();
  if (options.workspace) {
    const root = absolutePath(options.workspace, cwd, home);
    await assertWorkspace(root);
    return root;
  }

  const envWorkspace = options.env?.PERSONAL_BENCH_WORKSPACE ?? process.env.PERSONAL_BENCH_WORKSPACE;
  if (envWorkspace) {
    const root = absolutePath(envWorkspace, cwd, home);
    await assertWorkspace(root);
    return root;
  }

  let current = cwd;
  while (true) {
    const metadataPath = join(current, ".personal-bench", "workspace.json");
    if (await pathExists(metadataPath)) {
      const metadata = await readJson(metadataPath);
      const workspaceRoot =
        typeof metadata.workspaceRoot === "string" ? absolutePath(metadata.workspaceRoot, current, home) : current;
      await assertWorkspace(workspaceRoot);
      return workspaceRoot;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const globalConfig = join(home, ".personal-bench", "config.json");
  if (await pathExists(globalConfig)) {
    const config = await readJson(globalConfig);
    if (typeof config.workspaceRoot === "string") {
      const root = absolutePath(config.workspaceRoot, home, home);
      await assertWorkspace(root);
      return root;
    }
  }

  if (options.createDefault) {
    const root = join(home, ".personal-bench", "workspace");
    await initWorkspace(root);
    await writeJson(globalConfig, { schemaVersion: 1, workspaceRoot: root, updatedAt: nowIso() });
    return root;
  }

  throw new Error(
    "No personal-bench workspace found. Run `yk pbench workspace-init ~/.personal-bench/workspace` or pass --workspace."
  );
}

export async function resolveCaseDirInput(options: { caseInput: string; cwd: string; home?: string; workspace?: string }): Promise<string> {
  const home = options.home ?? homedir();
  const candidatePath = absolutePath(options.caseInput, options.cwd, home);
  if (await pathExists(join(candidatePath, "case.json"))) return candidatePath;
  if (isAbsolute(expandHome(options.caseInput, home)) || options.caseInput.includes(sep) || options.caseInput.includes("/")) {
    throw new Error(`PBench case not found: ${candidatePath}`);
  }
  const workspaceRoot = await resolveWorkspaceRoot({
    workspace: options.workspace,
    cwd: options.cwd,
    home
  });
  const caseDir = join(workspaceRoot, "cases", options.caseInput);
  if (!(await pathExists(join(caseDir, "case.json")))) {
    throw new Error(`PBench case not found: ${caseDir}`);
  }
  return caseDir;
}

export async function resolveReportCaseFilter(options: {
  caseInput?: string;
  cwd: string;
  home?: string;
}): Promise<string | undefined> {
  if (!options.caseInput) return undefined;
  const home = options.home ?? homedir();
  const expanded = expandHome(options.caseInput, home);
  if (isAbsolute(expanded) || options.caseInput.includes(sep) || options.caseInput.includes("/")) {
    const caseDir = absolutePath(options.caseInput, options.cwd, home);
    const manifest = await readJson(join(caseDir, "case.json"));
    return typeof manifest.id === "string" ? manifest.id : options.caseInput;
  }
  return options.caseInput;
}
