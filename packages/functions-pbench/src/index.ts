import type { FunctionCommand } from "@ya-skills/core";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { stdin as input, stdout as output } from "node:process";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";

type JsonObject = Record<string, unknown>;

const MAX_PUBLIC_TEXT_FILE_BYTES = 64 * 1024;
const MAX_PUBLIC_PATCH_BYTES = 512 * 1024;
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });
const VALIDATOR_AUTHORING_SENTINEL = "PBENCH_AUTHORING_REQUIRED";
const PUBLIC_REPLAY_MANIFEST_PATH = "public/replay.manifest.json";
const PUBLIC_CONTEXT_MANIFEST_PATH = "public/context.manifest.json";
const PUBLIC_KEY_OBSERVATIONS_PATH = "public/key-observations.md";
const PUBLIC_COMMAND_OBSERVATIONS_PATH = "public/command-observations.md";
const PBENCH_RUNNER_SKILL_NAME = "pbench-runner";
const PRIVATE_PATH_PLACEHOLDER = "<private-path>";
const SUBJECT_REPO_PLACEHOLDER = "<subject-repo>";

type ReplayRequirements = {
  profile: "local" | "live-integration";
  network: "none" | "optional" | "required" | "unknown";
  requiredEnv: string[];
  notes: string[];
};

type PbenchRunStatus = "running" | "passed" | "blocked" | "setup_failed" | "agent_failed" | "validator_failed";

type RunState = JsonObject & {
  schemaVersion: 1;
  runId: string;
  caseId: string;
  caseDir: string;
  workspaceRoot: string;
  artifactDir: string;
  worktree: string;
  repoCache: string;
  agentMode: "codex" | "skill";
  profile: string;
  status: PbenchRunStatus;
  terminal: boolean;
  manualIntervention: boolean;
  requiredEnv: string[];
  events?: RunEvent[];
  createdAt: string;
  updatedAt: string;
};

export type ValidationResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  validatorOutcomes?: ValidatorOutcome[];
};

export type ValidatorOutcome = {
  id: string;
  expected: "pass" | "fail";
  actual: "pass" | "fail";
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export type WorkspaceInfo = {
  root: string;
  metadataPath: string;
};

export type CaptureOptions = {
  cwd?: string;
  workspaceRoot?: string;
  input?: string;
  sessionId?: string;
  yes?: boolean;
  title?: string;
  now?: Date;
  home?: string;
  confirm?: (plan: CapturePlan) => boolean | Promise<boolean>;
};

export type CaptureResult = {
  transactionPath: string;
  caseDir: string;
  caseId: string;
  workspaceRoot: string;
  warnings: string[];
};

export type CapturePlan = {
  inputPath: string;
  sourceRepoRoot: string;
  baselineCommit: string;
  title: string;
  sessionId: string;
  sessionCwd: string | null;
  model: string | null;
};

type ParsedArgs = {
  options: Record<string, string | boolean>;
  positionals: string[];
};

type PbenchCommandOptions = {
  home?: string;
};

type RunEvent = {
  phase: "setup" | "agent" | "validator" | "finish";
  status: string;
  at: string;
  message?: string;
  exitCode?: number | null;
};

type PbenchReportRun = {
  runId: string;
  caseId: string;
  profile: string;
  status: string;
  artifactDir: string;
  summaryPath: string;
  agentMode: string;
  manualIntervention: boolean;
  durationMs: number | null;
  tokenUsage: JsonObject;
  createdAt: string | null;
  updatedAt: string | null;
};

export function createPbenchCommands(options: PbenchCommandOptions = {}): FunctionCommand[] {
  return [
    {
      domain: "pbench",
      action: "capture",
      description: "Create a persistent pbench authoring transaction from a Codex session.",
      run: async (args) => {
        const parsed = parseArgs(args);
        const source = getString(parsed, "source");
        if (source !== "codex") {
          throw new Error("yk pbench capture supports only --source codex");
        }
        const workspace = getString(parsed, "workspace");
        const yes = getBoolean(parsed, "yes");
        const workspaceRoot = workspace
          ? await resolveWorkspaceRoot({ workspace, cwd: process.cwd(), home: options.home, createDefault: yes })
          : await resolveWorkspaceRoot({ cwd: process.cwd(), home: options.home, createDefault: yes });
        const result = await captureCodexSession({
          cwd: process.cwd(),
          workspaceRoot,
          input: getString(parsed, "input"),
          sessionId: getString(parsed, "session-id"),
          yes,
          title: getString(parsed, "title"),
          home: options.home
        });
        return printJson({
          ...result,
          initialValidation: await validateAuthoringDraft(result.caseDir),
          next: [
            `Review ${result.caseDir}`,
            `yk pbench validate --transaction ${result.transactionPath} --strict`,
            `yk pbench finalize --transaction ${result.transactionPath}`
          ]
        });
      }
    },
    {
      domain: "pbench",
      action: "validate",
      description: "Validate a pbench transaction or case bundle.",
      run: async (args) => {
        const parsed = parseArgs(args);
        const transaction = getString(parsed, "transaction");
        const caseDir = getString(parsed, "case");
        let result: ValidationResult;
        if (transaction) {
          result = getBoolean(parsed, "strict")
            ? await strictValidateTransaction(transaction)
            : await validateCaseBundle(join(absolutePath(transaction), "case"), { strict: false });
        } else if (caseDir) {
          result = await validateCaseBundle(caseDir, {
            strict: getBoolean(parsed, "strict"),
            workspaceRoot: getString(parsed, "workspace")
          });
        } else {
          throw new Error("Pass --transaction <path> or --case <path>.");
        }
        return printJson(result);
      }
    },
    {
      domain: "pbench",
      action: "export-replay",
      description: "Export a public-only pbench replay capsule for an agent.",
      run: async (args) => {
        const parsed = parseArgs(args);
        const caseInput = requireString(parsed, "case", "yk pbench export-replay requires --case <case-dir-or-case-id>");
        const out = requireString(parsed, "out", "yk pbench export-replay requires --out <dir>");
        const caseDir = await resolveCaseDirInput({
          caseInput,
          cwd: process.cwd(),
          home: options.home,
          workspace: getString(parsed, "workspace")
        });
        return printJson(
          await exportReplayCapsule({
            caseDir,
            outDir: absolutePath(out, process.cwd(), options.home ?? homedir()),
            force: getBoolean(parsed, "force")
          })
        );
      }
    },
    {
      domain: "pbench",
      action: "run",
      description: "Run a pbench case through a harness-managed agent and private validator.",
      run: async (args) => {
        const parsed = parseArgs(args);
        const caseInput = requireString(parsed, "case", "yk pbench run requires --case <case-dir-or-case-id>");
        const agent = getString(parsed, "agent") ?? "codex";
        if (agent !== "codex") {
          throw new Error(`yk pbench run supports only --agent codex in v1: ${agent}`);
        }
        const workspaceRoot = await resolveWorkspaceRoot({
          workspace: getString(parsed, "workspace"),
          cwd: process.cwd(),
          home: options.home
        });
        const caseDir = await resolveCaseDirInput({
          caseInput,
          cwd: process.cwd(),
          home: options.home,
          workspace: workspaceRoot
        });
        return printJson(
          await runPbenchCase({
            caseDir,
            workspaceRoot,
            home: options.home,
            profile: normalizeRunProfile(getString(parsed, "profile"))
          })
        );
      }
    },
    {
      domain: "pbench",
      action: "start",
      description: "Prepare a pbench case for a skill-mediated benchmark run.",
      run: async (args) => {
        const parsed = parseArgs(args);
        const caseInput = requireString(parsed, "case", "yk pbench start requires --case <case-dir-or-case-id>");
        const workspaceRoot = await resolveWorkspaceRoot({
          workspace: getString(parsed, "workspace"),
          cwd: process.cwd(),
          home: options.home
        });
        const caseDir = await resolveCaseDirInput({
          caseInput,
          cwd: process.cwd(),
          home: options.home,
          workspace: workspaceRoot
        });
        return printJson(
          await startSkillMediatedRun({
            caseDir,
            workspaceRoot,
            home: options.home,
            profile: normalizeRunProfile(getString(parsed, "profile"))
          })
        );
      }
    },
    {
      domain: "pbench",
      action: "finish",
      description: "Finish a skill-mediated pbench run with private validation.",
      run: async (args) => {
        const parsed = parseArgs(args);
        const runId = requireString(parsed, "run", "yk pbench finish requires --run <run-id>");
        return printJson(await finishPbenchRun({ runId, home: options.home }));
      }
    },
    {
      domain: "pbench",
      action: "finalize",
      description: "Finalize a strict-validated pbench transaction.",
      run: async (args) => {
        const parsed = parseArgs(args);
        const transaction = requireString(parsed, "transaction", "yk pbench finalize requires --transaction <path>");
        return printJson(await finalizeTransaction(transaction));
      }
    },
    {
      domain: "pbench",
      action: "report",
      description: "Aggregate pbench run artifacts into a benchmark report.",
      run: async (args) => {
        const parsed = parseArgs(args);
        const workspaceRoot = await resolveWorkspaceRoot({
          workspace: getString(parsed, "workspace"),
          cwd: process.cwd(),
          home: options.home
        });
        const report = await buildPbenchReport({
          workspaceRoot,
          caseFilter: await resolveReportCaseFilter({
            caseInput: getString(parsed, "case"),
            cwd: process.cwd(),
            home: options.home
          }),
          profileFilter: getString(parsed, "profile") ? normalizeRunProfile(getString(parsed, "profile")) : undefined
        });
        const format = getString(parsed, "format") ?? "json";
        if (format === "markdown") {
          return renderPbenchReportMarkdown(report);
        }
        if (format !== "json") {
          throw new Error(`Unsupported pbench report format: ${format}`);
        }
        return printJson(report);
      }
    },
    {
      domain: "pbench",
      action: "audit",
      description: "Audit pbench case quality without running private validators.",
      run: async (args) => {
        const parsed = parseArgs(args);
        const caseInput = requireString(parsed, "case", "yk pbench audit requires --case <case-dir-or-case-id>");
        const caseDir = await resolveCaseDirInput({
          caseInput,
          cwd: process.cwd(),
          home: options.home,
          workspace: getString(parsed, "workspace")
        });
        return printJson(await auditPbenchCase(caseDir));
      }
    },
    {
      domain: "pbench",
      action: "workspace-init",
      description: "Initialize a pbench workspace.",
      run: async (args) => {
        const parsed = parseArgs(args);
        const path = parsed.positionals[0];
        if (!path) {
          throw new Error("yk pbench workspace-init requires <path>");
        }
        return printJson(await initWorkspace(path));
      }
    },
    {
      domain: "pbench",
      action: "project-link",
      description: "Link the current project to a pbench workspace.",
      run: async (args) => {
        const parsed = parseArgs(args);
        const workspace = requireString(parsed, "workspace", "yk pbench project-link requires --workspace <path>");
        return printJson({ linkPath: await linkProject(process.cwd(), workspace) });
      }
    }
  ];
}

function parseArgs(args: string[]): ParsedArgs {
  const options: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index += 1;
  }
  return { options, positionals };
}

function getString(parsed: ParsedArgs, key: string): string | undefined {
  const value = parsed.options[key];
  return typeof value === "string" ? value : undefined;
}

function requireString(parsed: ParsedArgs, key: string, message: string): string {
  const value = getString(parsed, key);
  if (!value) {
    throw new Error(message);
  }
  return value;
}

function getBoolean(parsed: ParsedArgs, key: string): boolean {
  return parsed.options[key] === true;
}

function printJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function nowIso(now = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function stamp(now = new Date()): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function expandHome(path: string, home = homedir()): string {
  if (path === "~") {
    return home;
  }
  if (path.startsWith(`~${sep}`)) {
    return join(home, path.slice(2));
  }
  return path;
}

function absolutePath(path: string, cwd = process.cwd(), home = homedir()): string {
  const expanded = expandHome(path, home);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

function pbenchCaptureRoot(home = homedir()): string {
  return join(home, ".ya-skills", "pbench");
}

function defaultReplayRequirements(): ReplayRequirements {
  return { profile: "local", network: "unknown", requiredEnv: [], notes: [] };
}

function normalizeReplayRequirements(value: unknown): ReplayRequirements {
  const object = asObject(value) ?? {};
  const profile = object.profile === "live-integration" ? "live-integration" : "local";
  const networkValues = new Set(["none", "optional", "required", "unknown"]);
  const network = typeof object.network === "string" && networkValues.has(object.network) ? object.network : "unknown";
  return {
    profile,
    network: network as ReplayRequirements["network"],
    requiredEnv: Array.isArray(object.requiredEnv)
      ? object.requiredEnv.filter((item): item is string => typeof item === "string" && item.length > 0)
      : [],
    notes: Array.isArray(object.notes)
      ? object.notes.filter((item): item is string => typeof item === "string" && item.length > 0)
      : []
  };
}

function normalizeRunProfile(value: string | undefined): string {
  const profile = value?.trim();
  return profile ? profile : "default";
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

async function readJson(path: string): Promise<JsonObject> {
  return JSON.parse(await readFile(path, "utf8")) as JsonObject;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function execGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function execGitDir(gitDir: string, args: string[]): string {
  return execFileSync("git", ["--git-dir", gitDir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

export function slugify(input: string): string {
  const ascii = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return (ascii || "case").slice(0, 60).replace(/-+$/g, "") || "case";
}

export function makeCaseId(title: string, now = new Date()): string {
  return `case_${slugify(title)}_${stamp(now)}`;
}

export async function initWorkspace(rootInput: string): Promise<WorkspaceInfo> {
  const root = absolutePath(rootInput);
  await mkdir(join(root, ".personal-bench"), { recursive: true });
  await mkdir(join(root, "cases"), { recursive: true });
  await mkdir(join(root, "repos"), { recursive: true });
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

async function assertWorkspace(root: string): Promise<void> {
  const metadataPath = join(root, ".personal-bench", "workspace.json");
  if (!(await pathExists(metadataPath))) {
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
    if (parent === current) {
      break;
    }
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

async function resolveCaseDirInput(options: { caseInput: string; cwd: string; home?: string; workspace?: string }): Promise<string> {
  const home = options.home ?? homedir();
  const candidatePath = absolutePath(options.caseInput, options.cwd, home);
  if (await pathExists(join(candidatePath, "case.json"))) {
    return candidatePath;
  }
  if (isAbsolute(expandHome(options.caseInput, home)) || options.caseInput.includes(sep) || options.caseInput.includes("/")) {
    throw new Error(`PBench case not found: ${candidatePath}`);
  }
  const workspaceRoot = options.workspace
    ? await resolveWorkspaceRoot({ workspace: options.workspace, cwd: options.cwd, home })
    : await resolveWorkspaceRoot({ cwd: options.cwd, home });
  const caseDir = join(workspaceRoot, "cases", options.caseInput);
  if (!(await pathExists(join(caseDir, "case.json")))) {
    throw new Error(`PBench case not found: ${caseDir}`);
  }
  return caseDir;
}

async function resolveReportCaseFilter(options: {
  caseInput?: string;
  cwd: string;
  home?: string;
}): Promise<string | undefined> {
  if (!options.caseInput) {
    return undefined;
  }
  const home = options.home ?? homedir();
  const expanded = expandHome(options.caseInput, home);
  if (isAbsolute(expanded) || options.caseInput.includes(sep) || options.caseInput.includes("/")) {
    const caseDir = absolutePath(options.caseInput, options.cwd, home);
    const manifest = await readJson(join(caseDir, "case.json"));
    return typeof manifest.id === "string" ? manifest.id : options.caseInput;
  }
  return options.caseInput;
}

async function exportReplayCapsule(options: {
  caseDir: string;
  outDir: string;
  force?: boolean;
}): Promise<{ outDir: string; caseId: string; exported: string[] }> {
  const manifest = await readJson(join(options.caseDir, "case.json"));
  const publicDir = join(options.caseDir, "public");
  if (!(await pathExists(publicDir))) {
    throw new Error(`Missing public replay directory: ${publicDir}`);
  }
  const publicCaseManifest = buildPublicCaseManifest(manifest);
  await assertPublicReplayHasNoPrivateReferences(publicDir, {
    caseDir: options.caseDir,
    extraSurfaces: [{ label: "case.public.json", text: JSON.stringify(publicCaseManifest, null, 2) }]
  });
  if (await pathExists(options.outDir)) {
    if (!options.force) {
      throw new Error(`Output directory already exists: ${options.outDir}. Pass --force to replace it.`);
    }
    await rm(options.outDir, { recursive: true, force: true });
  }
  await mkdir(options.outDir, { recursive: true });
  await cp(publicDir, join(options.outDir, "public"), { recursive: true, force: false });
  await writeJson(join(options.outDir, "case.public.json"), publicCaseManifest);
  return { outDir: options.outDir, caseId: String(manifest.id ?? ""), exported: ["case.public.json", "public/"] };
}

function buildPublicCaseManifest(manifest: JsonObject): JsonObject {
  const documents = asObject(manifest.documents) ?? {};
  const publicDocuments = Object.fromEntries(
    Object.entries(documents).filter(([, value]) => typeof value === "string" && value.startsWith("public/"))
  );
  const publicSubjects = asArray(manifest.subjects).map((subject) => {
    const publicSubject = { ...subject };
    delete publicSubject.sourceRootAtCapture;
    return publicSubject;
  });
  return {
    $schema: manifest.$schema,
    schemaVersion: manifest.schemaVersion,
    id: manifest.id,
    title: manifest.title,
    status: manifest.status,
    privacy: manifest.privacy,
    metadata: manifest.metadata,
    documents: publicDocuments,
    subjects: publicSubjects,
    setupCommands: manifest.setupCommands,
    replayRequirements: normalizeReplayRequirements(manifest.replayRequirements)
  };
}

type AgentVisibleSurface = {
  label: string;
  text: string;
};

function forbiddenAgentVisibleHits(text: string, forbiddenPaths: string[]): string[] {
  const hits: string[] = [];
  if (/(^|[\s"'`(=:[{])\/private(?:\/[^\s"'`)<>\]}]*)?/.test(text)) {
    hits.push("absolute /private path");
  }
  if (/(^|[\s"'`(=:[{])(?:\.\/)?private[\\/][^\s"'`)<>\]}]*/.test(text)) {
    hits.push("private evaluator path");
  }
  if (/\bPB_PRIVATE_DIR\b/.test(text)) {
    hits.push("PB_PRIVATE_DIR");
  }
  if (/\bPB_CASE_DIR\b/.test(text)) {
    hits.push("PB_CASE_DIR");
  }
  if (/(^|[\s"'`(=:[{])codex-session\.jsonl\b/.test(text)) {
    hits.push("raw transcript path");
  }
  for (const path of forbiddenPaths) {
    if (path && text.includes(path)) {
      hits.push("original case directory");
    }
  }
  return [...new Set(hits)];
}

function assertNoAgentVisiblePrivateReferences(
  surfaces: AgentVisibleSurface[],
  options: { forbiddenPaths?: string[] } = {}
): void {
  const labels = new Set<string>();
  const forbiddenPaths = (options.forbiddenPaths ?? []).filter((path) => path.length > 0);
  for (const surface of surfaces) {
    const hits = forbiddenAgentVisibleHits(surface.text, forbiddenPaths);
    if (hits.length > 0) {
      labels.add(`${surface.label} (${hits.join(", ")})`);
    }
  }
  if (labels.size > 0) {
    throw new Error(`Agent-visible pbench replay input contains private evaluator path references: ${[...labels].join(", ")}`);
  }
}

async function assertPublicReplayHasNoPrivateReferences(
  publicDir: string,
  options: { caseDir?: string; extraSurfaces?: AgentVisibleSurface[] } = {}
): Promise<void> {
  const surfaces: AgentVisibleSurface[] = [];
  for (const file of await listFilesRecursively(publicDir)) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    surfaces.push({ label: `public/${relativePathFrom(publicDir, file)}`, text });
  }
  surfaces.push(...(options.extraSurfaces ?? []));
  assertNoAgentVisiblePrivateReferences(surfaces, { forbiddenPaths: options.caseDir ? [options.caseDir] : [] });
}

async function listFilesRecursively(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursively(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function pbenchRunStateRoot(home = homedir()): string {
  return join(home, ".ya-skills", "pbench", "runs");
}

function runStatePath(home: string | undefined, runId: string): string {
  return join(pbenchRunStateRoot(home ?? homedir()), `${runId}.json`);
}

function makeRunId(caseId: string): string {
  const suffix = randomBytes(4).toString("hex");
  return `run_${slugify(caseId)}_${stamp()}_${suffix}`;
}

function publicRunFile(runId: string): JsonObject {
  return {
    schemaVersion: 1,
    runId,
    finishCommand: `yk pbench finish --run ${runId}`,
    publicFiles: {
      prompt: ".pbench/public/prompt.md",
      replay: ".pbench/public/replay.md",
      contextManifest: ".pbench/public/context.manifest.json",
      replayManifest: ".pbench/public/replay.manifest.json",
      casePublic: ".pbench/case.public.json"
    }
  };
}

const PBENCH_RUNNER_SKILL_MARKDOWN = `---
name: pbench-runner
description: Use when a pbench benchmark worktree contains .pbench/run.json and the agent must complete the public replay task before triggering final validation.
---

# PBench Runner

Use this skill only inside a worktree prepared by \`yk pbench start\`.

1. Read \`.pbench/public/prompt.md\`, \`.pbench/public/replay.md\`, and \`.pbench/case.public.json\`.
2. Complete the benchmark task in the current repository worktree.
3. Use only files listed in the public replay capsule. Do not search for private evaluator files, private validators, raw transcripts, or the original case directory.
4. When finished, read \`.pbench/run.json\` and run its \`finishCommand\`.
5. Report only the finish result and any public work you changed.
`;

function runnerSkillManifest(): JsonObject {
  return {
    name: PBENCH_RUNNER_SKILL_NAME,
    description: "Use when a pbench benchmark worktree contains .pbench/run.json and must be completed through an agent skill."
  };
}

async function installRunnerSkill(worktree: string): Promise<void> {
  const skillDir = join(worktree, ".agents", "skills", PBENCH_RUNNER_SKILL_NAME);
  await mkdir(skillDir, { recursive: true });
  await writeJson(join(skillDir, "skill.json"), runnerSkillManifest());
  await writeFile(join(skillDir, "SKILL.md"), PBENCH_RUNNER_SKILL_MARKDOWN);
}

function ensureRequiredReplayEnv(manifest: JsonObject): string[] {
  const required = requiredReplayEnv(manifest);
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required replay environment variables: ${missing.join(", ")}`);
  }
  return required;
}

async function loadRunnableCase(caseDir: string, workspaceRoot: string): Promise<{
  manifest: JsonObject;
  caseId: string;
  repoCache: string;
  commit: string;
  requiredEnv: string[];
}> {
  const validation = await validateCaseBundle(caseDir, { strict: false });
  if (!validation.ok) {
    throw new Error(`Invalid pbench case:\n${validation.errors.join("\n")}`);
  }
  const manifest = await readJson(join(caseDir, "case.json"));
  const requiredEnv = ensureRequiredReplayEnv(manifest);
  await assertPublicReplayHasNoPrivateReferences(join(caseDir, "public"), {
    caseDir,
    extraSurfaces: [{ label: "case.public.json", text: JSON.stringify(buildPublicCaseManifest(manifest), null, 2) }]
  });
  const subject = asArray(manifest.subjects)[0];
  const baseline = asObject(subject?.baseline);
  const commit = String(baseline?.commit ?? "");
  const repoCache = repoCacheForSubject(workspaceRoot, subject ?? {});
  const errors: string[] = [];
  if (!subject) {
    errors.push("V1 requires exactly one git subject.");
  }
  if (!(await pathExists(repoCache))) {
    errors.push(`Missing repo cache: ${repoCache}`);
  } else {
    try {
      execGitDir(repoCache, ["cat-file", "-e", `${commit}^{commit}`]);
    } catch {
      errors.push(`Baseline commit not present in repo cache: ${commit}`);
    }
    if (baseline?.ref) {
      try {
        const refCommit = execGitDir(repoCache, ["rev-parse", String(baseline.ref)]);
        if (refCommit !== commit) {
          errors.push(`Baseline ref ${String(baseline.ref)} points to ${refCommit}, expected ${commit}`);
        }
      } catch {
        errors.push(`Missing baseline ref: ${String(baseline.ref)}`);
      }
    }
  }
  if (errors.length > 0) {
    throw new Error(`Cannot prepare pbench run:\n${errors.join("\n")}`);
  }
  return { manifest, caseId: String(manifest.id), repoCache, commit, requiredEnv };
}

function makeRedactor(requiredEnv: string[]): (text: string) => string {
  const replacements = requiredEnv
    .map((name) => ({ name, value: process.env[name] }))
    .filter((item): item is { name: string; value: string } => typeof item.value === "string" && item.value.length > 0);
  return (text: string) => {
    let outputText = text;
    for (const { name, value } of replacements) {
      outputText = outputText.split(value).join(`[REDACTED:${name}]`);
    }
    return outputText;
  };
}

async function saveRunState(state: RunState, home?: string): Promise<void> {
  state.updatedAt = nowIso();
  await writeJson(runStatePath(home, state.runId), state);
  await writeJson(join(state.artifactDir, "run.json"), state);
}

async function readRunState(runId: string, home?: string): Promise<RunState> {
  return (await readJson(runStatePath(home, runId))) as RunState;
}

async function writeRunSummary(state: RunState, details: string[] = []): Promise<string> {
  const path = join(state.artifactDir, "summary.md");
  await writeFile(
    path,
    [
      `# PBench Run ${state.runId}`,
      "",
      `- Case: ${state.caseId}`,
      `- Status: ${state.status}`,
      `- Agent mode: ${state.agentMode}`,
      `- Manual intervention: ${String(state.manualIntervention)}`,
      "",
      ...details
    ].join("\n")
  );
  return path;
}

function runEvent(phase: RunEvent["phase"], status: string, fields: Omit<RunEvent, "phase" | "status" | "at"> = {}): RunEvent {
  return { phase, status, at: nowIso(), ...fields };
}

function setupRunEvent(setupOutcomes: ValidatorOutcome[]): RunEvent {
  if (setupOutcomes.length === 0) {
    return runEvent("setup", "skipped", { message: "No setup commands configured." });
  }
  const failed = setupOutcomes.find((outcome) => outcome.actual !== "pass");
  if (failed) {
    return runEvent("setup", "failed", { message: failed.id, exitCode: failed.exitCode });
  }
  return runEvent("setup", "passed", { message: `${setupOutcomes.length} setup command(s) passed.` });
}

function validatorRunEvent(outcomes: ValidatorOutcome[]): RunEvent {
  const failed = outcomes.find((outcome) => outcome.actual !== outcome.expected);
  if (failed) {
    return runEvent("validator", "failed", { message: failed.id, exitCode: failed.exitCode });
  }
  return runEvent("validator", "passed", { message: `${outcomes.length} validator(s) passed.` });
}

function validatorCounts(outcomes: ValidatorOutcome[] = []): { total: number; passed: number; failed: number } {
  const passed = outcomes.filter((outcome) => outcome.actual === outcome.expected).length;
  return { total: outcomes.length, passed, failed: outcomes.length - passed };
}

function tokenUsageFromState(state: RunState): JsonObject {
  return asObject(state.tokenUsage) ?? {};
}

async function writeRunMetrics(state: RunState, options: { validatorOutcomes?: ValidatorOutcome[] } = {}): Promise<void> {
  await writeJson(join(state.artifactDir, "metrics.json"), {
    schemaVersion: 1,
    runId: state.runId,
    caseId: state.caseId,
    profile: state.profile ?? "default",
    status: state.status,
    agentMode: state.agentMode,
    manualIntervention: state.manualIntervention,
    durationMs: typeof state.durationMs === "number" ? state.durationMs : null,
    tokenUsage: tokenUsageFromState(state),
    validator: validatorCounts(options.validatorOutcomes),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    finishedAt: typeof state.finishedAt === "string" ? state.finishedAt : null
  });
}

async function writeRunEvents(state: RunState, events: RunEvent[]): Promise<void> {
  await writeJson(join(state.artifactDir, "events.json"), {
    schemaVersion: 1,
    runId: state.runId,
    caseId: state.caseId,
    profile: state.profile ?? "default",
    events
  });
}

async function writeTerminalRunArtifacts(
  state: RunState,
  options: { events: RunEvent[]; validatorOutcomes?: ValidatorOutcome[] }
): Promise<void> {
  state.events = options.events;
  await writeRunMetrics(state, { validatorOutcomes: options.validatorOutcomes });
  await writeRunEvents(state, options.events);
}

async function preparePublicCapsule(caseDir: string, manifest: JsonObject, worktree: string, runId: string): Promise<void> {
  const pbenchDir = join(worktree, ".pbench");
  const publicCaseManifest = buildPublicCaseManifest(manifest);
  await rm(pbenchDir, { recursive: true, force: true });
  await mkdir(pbenchDir, { recursive: true });
  await cp(join(caseDir, "public"), join(pbenchDir, "public"), { recursive: true, force: false });
  await writeJson(join(pbenchDir, "case.public.json"), publicCaseManifest);
  await writeJson(join(pbenchDir, "run.json"), publicRunFile(runId));
}

async function assertPreparedAgentVisibleInputs(options: {
  worktree: string;
  caseDir: string;
  agentPrompt: string;
}): Promise<void> {
  const pbenchDir = join(options.worktree, ".pbench");
  const surfaces: AgentVisibleSurface[] = [
    { label: ".pbench/case.public.json", text: await readFile(join(pbenchDir, "case.public.json"), "utf8") },
    { label: ".pbench/run.json", text: await readFile(join(pbenchDir, "run.json"), "utf8") },
    { label: "codex prompt", text: options.agentPrompt }
  ];
  const runnerSkillPath = join(options.worktree, ".agents", "skills", PBENCH_RUNNER_SKILL_NAME, "SKILL.md");
  if (await pathExists(runnerSkillPath)) {
    surfaces.push({ label: ".agents/skills/pbench-runner/SKILL.md", text: await readFile(runnerSkillPath, "utf8") });
  }
  await assertPublicReplayHasNoPrivateReferences(join(pbenchDir, "public"), {
    caseDir: options.caseDir,
    extraSurfaces: surfaces
  });
}

async function applyStartingPatch(caseDir: string, worktree: string): Promise<void> {
  const manifestPath = join(caseDir, PUBLIC_REPLAY_MANIFEST_PATH);
  if (!(await pathExists(manifestPath))) {
    return;
  }
  const replayManifest = await readJson(manifestPath);
  const replayFiles = asObject(replayManifest.replayFiles) ?? {};
  const startingPatch = safeRelativePath(replayFiles.startingPatch);
  if (!startingPatch) {
    return;
  }
  const patchPath = join(caseDir, startingPatch);
  if (await pathExists(patchPath)) {
    execFileSync("git", ["apply", "--binary", patchPath], { cwd: worktree, stdio: ["ignore", "pipe", "pipe"] });
  }
}

function publicRunnerEnv(worktree: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.PB_CASE_DIR;
  delete env.PB_PRIVATE_DIR;
  delete env.PB_PUBLIC_DIR;
  env.PB_REPLAY_DIR = worktree;
  return env;
}

function privateValidatorEnv(caseDir: string, worktree: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PB_CASE_DIR: caseDir,
    PB_PUBLIC_DIR: join(caseDir, "public"),
    PB_PRIVATE_DIR: join(caseDir, "private"),
    PB_REPLAY_DIR: worktree
  };
}

function runSetupCommands(manifest: JsonObject, worktree: string, env: NodeJS.ProcessEnv): ValidatorOutcome[] {
  const outcomes: ValidatorOutcome[] = [];
  for (const setup of asArray(manifest.setupCommands)) {
    const command = String(setup.command ?? "");
    if (!command) {
      continue;
    }
    const cwd = join(worktree, safeRelativePath(setup.cwd ?? ".") ?? ".");
    const outcome = runShell(command, cwd, Number(setup.timeoutSeconds ?? 300), env);
    outcome.id = command;
    outcome.expected = "pass";
    outcomes.push(outcome);
    if (outcome.actual !== "pass") {
      break;
    }
  }
  return outcomes;
}

async function writeAgentDiff(
  worktree: string,
  artifactDir: string,
  redactor: (text: string) => string = (text) => text
): Promise<string> {
  const tracked = execGitOptional(worktree, ["diff", "--binary", "HEAD", "--", "."]);
  const untracked = execGitOptional(worktree, ["ls-files", "--others", "--exclude-standard"])
    .split(/\r?\n/)
    .map((file) => file.trim())
    .filter((file) => file.length > 0 && !file.startsWith(".pbench/"));
  const untrackedSection =
    untracked.length > 0
      ? ["", "Untracked files:", ...untracked.map((file) => `- ${file}`), ""].join("\n")
      : "";
  const diff = `${tracked}${untrackedSection}`;
  const path = join(artifactDir, "agent.diff");
  await writeFile(path, redactor(diff));
  return path;
}

function renderAgentPrompt(): string {
  return [
    "You are running a pbench benchmark in this repository worktree.",
    "Read .pbench/public/prompt.md first, then .pbench/public/replay.md and .pbench/case.public.json.",
    "Use only the public replay capsule under .pbench/public and the repository files in this worktree.",
    "Do not search for private evaluator files, private validators, raw transcripts, or the original case directory.",
    "Complete the task, modify the repository as needed, and leave verification artifacts in the worktree."
  ].join("\n");
}

function parseCodexJsonlSummary(stdoutText: string): { lastMessage: string | null; tokenUsage: JsonObject | null } {
  let last: string | null = null;
  let tokenUsage: JsonObject | null = null;
  for (const line of stdoutText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as JsonObject;
      const payload = asObject(record.payload);
      const usage = asObject(record.usage) ?? asObject(payload?.usage);
      if (usage) {
        tokenUsage = usage;
      }
      const content = record.content ?? payload?.content;
      const text = valueToText(content);
      if (text) {
        last = text;
      }
    } catch {
      // Non-JSON output is still stored as stdout.
    }
  }
  return { lastMessage: last, tokenUsage };
}

async function copyAgentProbeFiles(worktree: string, artifactDir: string, redactor: (text: string) => string): Promise<void> {
  for (const [source, destination] of [
    [join(worktree, ".pbench", "fake-codex-stdin.txt"), join(artifactDir, "agent-stdin.txt")],
    [join(worktree, ".pbench", "fake-codex-env.json"), join(artifactDir, "agent-env.json")],
    [join(worktree, ".pbench", "fake-codex-visible.txt"), join(artifactDir, "agent-visible.txt")]
  ]) {
    if (await pathExists(source)) {
      await writeFile(destination, redactor(await readFile(source, "utf8")));
    }
  }
}

function spawnCodexAgent(worktree: string, prompt: string): { exitCode: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    "codex",
    ["--ask-for-approval", "never", "exec", "--json", "--ephemeral", "--cd", worktree, "--sandbox", "workspace-write", "-"],
    {
      cwd: worktree,
      input: prompt,
      encoding: "utf8",
      env: publicRunnerEnv(worktree),
      timeout: 30 * 60 * 1000
    }
  );
  return {
    exitCode: result.status ?? (result.signal ? 124 : null),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

async function createStartedRun(options: {
  caseDir: string;
  workspaceRoot: string;
  home?: string;
  agentMode: "codex" | "skill";
  profile: string;
}): Promise<{ state: RunState; manifest: JsonObject; redactor: (text: string) => string }> {
  const { manifest, caseId, repoCache, commit, requiredEnv } = await loadRunnableCase(options.caseDir, options.workspaceRoot);
  const runId = makeRunId(caseId);
  const artifactDir = join(options.workspaceRoot, "runs", runId);
  await mkdir(artifactDir, { recursive: true });
  const worktree = await createReplayWorktree(repoCache, commit, options.workspaceRoot, runId);
  const redactor = makeRedactor(requiredEnv);
  const state: RunState = {
    schemaVersion: 1,
    runId,
    caseId,
    caseDir: options.caseDir,
    workspaceRoot: options.workspaceRoot,
    artifactDir,
    worktree,
    repoCache,
    agentMode: options.agentMode,
    profile: options.profile,
    status: "running",
    terminal: false,
    manualIntervention: options.agentMode === "skill",
    requiredEnv,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };

  try {
    await preparePublicCapsule(options.caseDir, manifest, worktree, runId);
    await applyStartingPatch(options.caseDir, worktree);
    if (options.agentMode === "skill") {
      await installRunnerSkill(worktree);
    }
    await assertPreparedAgentVisibleInputs({ worktree, caseDir: options.caseDir, agentPrompt: renderAgentPrompt() });
    const setupOutcomes = runSetupCommands(manifest, worktree, publicRunnerEnv(worktree));
    state.events = [setupRunEvent(setupOutcomes)];
    if (setupOutcomes.length > 0) {
      await writeFile(join(artifactDir, "setup-outcomes.json"), redactor(JSON.stringify(setupOutcomes, null, 2)));
      const failed = setupOutcomes.find((outcome) => outcome.actual !== "pass");
      if (failed) {
        state.status = "setup_failed";
        state.terminal = true;
        state.finishedAt = nowIso();
        await writeAgentDiff(worktree, artifactDir, redactor);
        await writeRunSummary(state, ["Setup failed before agent execution."]);
        await writeTerminalRunArtifacts(state, {
          events: [...(state.events ?? []), runEvent("finish", "setup_failed", { message: "Setup failed before agent execution." })]
        });
        await saveRunState(state, options.home);
        await cleanupReplayWorktree(repoCache, worktree);
        return { state, manifest, redactor };
      }
    }
    await saveRunState(state, options.home);
    return { state, manifest, redactor };
  } catch (error) {
    await cleanupReplayWorktree(repoCache, worktree);
    throw error;
  }
}

async function completeRunWithValidators(state: RunState, manifest: JsonObject, home?: string): Promise<RunState> {
  const errors: string[] = [];
  const redactor = makeRedactor(state.requiredEnv);
  const outcomes = await runValidators({
    caseDir: state.caseDir,
    manifest,
    replayRoot: state.worktree,
    env: privateValidatorEnv(state.caseDir, state.worktree),
    expectedMode: "candidate",
    errors
  });
  await writeFile(join(state.artifactDir, "validator-outcomes.json"), redactor(`${JSON.stringify(outcomes, null, 2)}\n`));
  await writeAgentDiff(state.worktree, state.artifactDir, redactor);
  state.status = errors.length === 0 ? "passed" : "validator_failed";
  state.terminal = true;
  state.finishedAt = nowIso();
  await writeRunSummary(state, errors.length === 0 ? ["Private validators passed."] : ["Private validators failed."]);
  await writeTerminalRunArtifacts(state, {
    events: [
      ...(state.events ?? []),
      validatorRunEvent(outcomes),
      runEvent("finish", state.status, { message: errors.length === 0 ? "Private validators passed." : "Private validators failed." })
    ],
    validatorOutcomes: outcomes
  });
  await saveRunState(state, home);
  await cleanupReplayWorktree(state.repoCache, state.worktree);
  return state;
}

async function runPbenchCase(options: {
  caseDir: string;
  workspaceRoot: string;
  home?: string;
  profile: string;
}): Promise<JsonObject> {
  const { state, manifest, redactor } = await createStartedRun({ ...options, agentMode: "codex" });
  if (state.terminal) {
    return { runId: state.runId, status: state.status, artifactDir: state.artifactDir, summaryPath: join(state.artifactDir, "summary.md") };
  }
  const prompt = renderAgentPrompt();
  await writeFile(join(state.artifactDir, "agent-stdin.txt"), redactor(prompt));
  const startedAt = Date.now();
  const agent = spawnCodexAgent(state.worktree, prompt);
  const durationMs = Date.now() - startedAt;
  await writeFile(join(state.artifactDir, "agent.stdout.log"), redactor(agent.stdout));
  await writeFile(join(state.artifactDir, "agent.stderr.log"), redactor(agent.stderr));
  await writeFile(join(state.artifactDir, "agent.jsonl"), redactor(agent.stdout));
  const agentSummary = parseCodexJsonlSummary(agent.stdout);
  if (agentSummary.lastMessage) {
    await writeFile(join(state.artifactDir, "agent-last-message.md"), redactor(agentSummary.lastMessage));
  }
  await copyAgentProbeFiles(state.worktree, state.artifactDir, redactor);
  state.agentExitCode = agent.exitCode;
  state.durationMs = durationMs;
  state.cost = null;
  state.tokenUsage = agentSummary.tokenUsage;
  state.events = [
    ...(state.events ?? []),
    runEvent("agent", agent.exitCode === 0 ? "passed" : "failed", {
      exitCode: agent.exitCode,
      message: agent.exitCode === 0 ? "Agent completed." : "Agent failed before private validation."
    })
  ];
  if (agent.exitCode !== 0) {
    state.status = "agent_failed";
    state.terminal = true;
    state.finishedAt = nowIso();
    await writeAgentDiff(state.worktree, state.artifactDir, redactor);
    await writeRunSummary(state, ["Agent failed before private validation."]);
    await writeTerminalRunArtifacts(state, {
      events: [...(state.events ?? []), runEvent("finish", "agent_failed", { message: "Agent failed before private validation." })]
    });
    await saveRunState(state, options.home);
    await cleanupReplayWorktree(state.repoCache, state.worktree);
  } else {
    await completeRunWithValidators(state, manifest, options.home);
  }
  return { runId: state.runId, status: state.status, artifactDir: state.artifactDir, summaryPath: join(state.artifactDir, "summary.md") };
}

async function startSkillMediatedRun(options: {
  caseDir: string;
  workspaceRoot: string;
  home?: string;
  profile: string;
}): Promise<JsonObject> {
  const { state } = await createStartedRun({ ...options, agentMode: "skill" });
  return {
    runId: state.runId,
    status: state.status,
    worktree: state.worktree,
    artifactDir: state.artifactDir,
    finishCommand: `yk pbench finish --run ${state.runId}`
  };
}

async function finishPbenchRun(options: { runId: string; home?: string }): Promise<JsonObject> {
  const state = await readRunState(options.runId, options.home);
  if (state.terminal || state.status !== "running") {
    throw new Error(`PBench run already finished: ${state.runId} (${state.status})`);
  }
  const manifest = await readJson(join(state.caseDir, "case.json"));
  const finished = await completeRunWithValidators(state, manifest, options.home);
  return { runId: finished.runId, status: finished.status, summaryPath: join(finished.artifactDir, "summary.md") };
}

async function readRunArtifact(path: string): Promise<JsonObject> {
  try {
    return await readJson(path);
  } catch (error) {
    throw new Error(`Malformed pbench run artifact: ${path}: ${(error as Error).message}`);
  }
}

function normalizeReportRun(run: JsonObject): PbenchReportRun {
  const artifactDir = typeof run.artifactDir === "string" ? run.artifactDir : "";
  return {
    runId: String(run.runId ?? ""),
    caseId: String(run.caseId ?? ""),
    profile: normalizeRunProfile(typeof run.profile === "string" ? run.profile : undefined),
    status: String(run.status ?? "unknown"),
    artifactDir,
    summaryPath: join(artifactDir, "summary.md"),
    agentMode: String(run.agentMode ?? "unknown"),
    manualIntervention: run.manualIntervention === true,
    durationMs: typeof run.durationMs === "number" ? run.durationMs : null,
    tokenUsage: asObject(run.tokenUsage) ?? {},
    createdAt: typeof run.createdAt === "string" ? run.createdAt : null,
    updatedAt: typeof run.updatedAt === "string" ? run.updatedAt : null
  };
}

function incrementCount(record: Record<string, number>, key: string, amount = 1): void {
  record[key] = (record[key] ?? 0) + amount;
}

function addTokenUsage(target: Record<string, number>, tokenUsage: JsonObject): void {
  for (const [key, value] of Object.entries(tokenUsage)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      incrementCount(target, key, value);
    }
  }
}

function sortObjectValues<T>(input: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right)));
}

async function listReportRuns(workspaceRoot: string): Promise<PbenchReportRun[]> {
  const runsRoot = join(workspaceRoot, "runs");
  if (!(await pathExists(runsRoot))) {
    return [];
  }
  const entries = await readdir(runsRoot, { withFileTypes: true });
  const runs: PbenchReportRun[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const runJsonPath = join(runsRoot, entry.name, "run.json");
    if (!(await pathExists(runJsonPath))) {
      continue;
    }
    runs.push(normalizeReportRun(await readRunArtifact(runJsonPath)));
  }
  return runs;
}

async function buildPbenchReport(options: {
  workspaceRoot: string;
  caseFilter?: string;
  profileFilter?: string;
}): Promise<JsonObject> {
  const filters: JsonObject = {};
  if (options.caseFilter) filters.caseId = options.caseFilter;
  if (options.profileFilter) filters.profile = options.profileFilter;
  const runs = (await listReportRuns(options.workspaceRoot)).filter((run) => {
    if (options.caseFilter && run.caseId !== options.caseFilter) return false;
    if (options.profileFilter && run.profile !== options.profileFilter) return false;
    return true;
  });

  const statusCounts: Record<string, number> = {};
  const caseIds = new Set<string>();
  const profiles: Record<
    string,
    { runs: number; passed: number; passRate: number; averageDurationMs: number | null; tokenUsage: Record<string, number>; durationTotal: number; durationCount: number }
  > = {};
  const cases: Record<string, { runs: number; profiles: Record<string, number>; statusCounts: Record<string, number> }> = {};
  let manualIntervention = 0;

  for (const run of runs) {
    caseIds.add(run.caseId);
    incrementCount(statusCounts, run.status);
    if (run.manualIntervention) manualIntervention += 1;

    profiles[run.profile] ??= {
      runs: 0,
      passed: 0,
      passRate: 0,
      averageDurationMs: null,
      tokenUsage: {},
      durationTotal: 0,
      durationCount: 0
    };
    const profile = profiles[run.profile];
    profile.runs += 1;
    if (run.status === "passed") profile.passed += 1;
    if (typeof run.durationMs === "number") {
      profile.durationTotal += run.durationMs;
      profile.durationCount += 1;
    }
    addTokenUsage(profile.tokenUsage, run.tokenUsage);

    cases[run.caseId] ??= { runs: 0, profiles: {}, statusCounts: {} };
    cases[run.caseId].runs += 1;
    incrementCount(cases[run.caseId].profiles, run.profile);
    incrementCount(cases[run.caseId].statusCounts, run.status);
  }

  const renderedProfiles = sortObjectValues(
    Object.fromEntries(
      Object.entries(profiles).map(([name, profile]) => [
        name,
        {
          runs: profile.runs,
          passed: profile.passed,
          passRate: profile.runs === 0 ? 0 : profile.passed / profile.runs,
          averageDurationMs: profile.durationCount === 0 ? null : profile.durationTotal / profile.durationCount,
          tokenUsage: sortObjectValues(profile.tokenUsage)
        }
      ])
    )
  );

  const renderedCases = sortObjectValues(
    Object.fromEntries(
      Object.entries(cases).map(([caseId, value]) => [
        caseId,
        {
          runs: value.runs,
          profiles: sortObjectValues(value.profiles),
          statusCounts: sortObjectValues(value.statusCounts)
        }
      ])
    )
  );

  const recentRuns = [...runs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")) || right.runId.localeCompare(left.runId))
    .slice(0, 20);

  return {
    schemaVersion: 1,
    workspaceRoot: options.workspaceRoot,
    filters,
    totals: {
      runs: runs.length,
      cases: caseIds.size,
      manualIntervention,
      statusCounts: sortObjectValues(statusCounts)
    },
    profiles: renderedProfiles,
    cases: renderedCases,
    recentRuns
  };
}

function formatPercent(value: unknown): string {
  return `${((typeof value === "number" ? value : 0) * 100).toFixed(1)}%`;
}

function formatNullableNumber(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(Math.round(value)) : "";
}

function renderPbenchReportMarkdown(report: JsonObject): string {
  const totals = asObject(report.totals) ?? {};
  const statusCounts = asObject(totals.statusCounts) ?? {};
  const profiles = asObject(report.profiles) ?? {};
  const lines = [
    "# PBench Report",
    "",
    `Workspace: ${String(report.workspaceRoot ?? "")}`,
    "",
    "## Totals",
    "",
    `Runs: ${String(totals.runs ?? 0)}`,
    `Cases: ${String(totals.cases ?? 0)}`,
    `Manual intervention: ${String(totals.manualIntervention ?? 0)}`,
    "",
    "## Status",
    "",
    "| Status | Runs |",
    "| --- | ---: |"
  ];
  for (const [status, count] of Object.entries(statusCounts)) {
    lines.push(`| ${status} | ${String(count)} |`);
  }
  if (Object.keys(statusCounts).length === 0) {
    lines.push("| none | 0 |");
  }

  lines.push(
    "",
    "## Profiles",
    "",
    "| Profile | Runs | Passed | Pass Rate | Avg Duration (ms) | Input Tokens | Output Tokens |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |"
  );
  for (const [name, rawProfile] of Object.entries(profiles)) {
    const profile = asObject(rawProfile) ?? {};
    const tokenUsage = asObject(profile.tokenUsage) ?? {};
    lines.push(
      `| ${name} | ${String(profile.runs ?? 0)} | ${String(profile.passed ?? 0)} | ${formatPercent(profile.passRate)} | ${formatNullableNumber(profile.averageDurationMs)} | ${String(tokenUsage.input_tokens ?? 0)} | ${String(tokenUsage.output_tokens ?? 0)} |`
    );
  }
  if (Object.keys(profiles).length === 0) {
    lines.push("| none | 0 | 0 | 0.0% |  | 0 | 0 |");
  }
  return `${lines.join("\n")}\n`;
}

async function auditPbenchCase(caseDir: string): Promise<JsonObject> {
  const validation = await validateCaseBundle(caseDir, { strict: false });
  const warnings = [...validation.warnings, ...(await findAuthoringWarnings(caseDir))];
  const errors = [...validation.errors];
  try {
    const manifest = await readJson(join(caseDir, "case.json"));
    await assertPublicReplayHasNoPrivateReferences(join(caseDir, "public"), {
      caseDir,
      extraSurfaces: [{ label: "case.public.json", text: JSON.stringify(buildPublicCaseManifest(manifest), null, 2) }]
    });
  } catch (error) {
    errors.push((error as Error).message);
  }
  let caseId = "";
  try {
    const manifest = await readJson(join(caseDir, "case.json"));
    caseId = typeof manifest.id === "string" ? manifest.id : "";
  } catch {
    // validateCaseBundle already reports unreadable manifests.
  }
  return {
    schemaVersion: 1,
    caseId,
    ok: errors.length === 0 && warnings.length === 0,
    errors,
    warnings
  };
}

export function resolveGitRoot(cwdInput: string): string {
  try {
    return execGit(absolutePath(cwdInput), ["rev-parse", "--show-toplevel"]);
  } catch {
    throw new Error(`Subject root must be inside a Git repository: ${cwdInput}`);
  }
}

function getHeadCommit(repoRoot: string): string {
  return execGit(repoRoot, ["rev-parse", "HEAD"]);
}

function getBranch(repoRoot: string): string | null {
  try {
    return execGit(repoRoot, ["branch", "--show-current"]) || null;
  } catch {
    return null;
  }
}

function getOrigin(repoRoot: string): string | null {
  try {
    return execGit(repoRoot, ["remote", "get-url", "origin"]) || null;
  } catch {
    return null;
  }
}

function canonicalRepoIdentity(repoRoot: string): string {
  const origin = getOrigin(repoRoot);
  return origin ? origin.trim().replace(/\.git$/, "").toLowerCase() : resolve(repoRoot);
}

function repoIdFor(repoRoot: string): string {
  const hash = createHash("sha256").update(canonicalRepoIdentity(repoRoot)).digest("hex").slice(0, 12);
  return `repo_${hash}`;
}

function syncRepoCache(
  workspaceRoot: string,
  sourceRepoRoot: string,
  commit: string,
  caseId: string
): { repoId: string; repoCachePath: string; ref: string } {
  const repoId = repoIdFor(sourceRepoRoot);
  const repoCachePath = join(workspaceRoot, "repos", `${repoId}.git`);
  if (!existsSync(repoCachePath)) {
    execFileSync("git", ["clone", "--bare", sourceRepoRoot, repoCachePath], { stdio: ["ignore", "pipe", "pipe"] });
  }
  try {
    execGitDir(repoCachePath, ["cat-file", "-e", `${commit}^{commit}`]);
  } catch {
    execGitDir(repoCachePath, ["fetch", sourceRepoRoot, commit]);
  }
  const ref = `refs/personal-bench/cases/${caseId}/baseline`;
  execGitDir(repoCachePath, ["update-ref", ref, commit]);
  return { repoId, repoCachePath, ref };
}

function safeRelativePath(pathValue: unknown): string | null {
  if (typeof pathValue !== "string" || pathValue.length === 0) {
    return null;
  }
  if (isAbsolute(pathValue)) {
    return null;
  }
  const normalized = pathValue.replace(/\\/g, "/");
  if (normalized.split("/").includes("..")) {
    return null;
  }
  return normalized;
}

async function ensureCaseSkeleton(caseDir: string): Promise<void> {
  await Promise.all(
    ["public/fixtures", "private/validators", "private/expected", "private/artifacts/raw", "private/artifacts/extracted"].map(
      (dir) => mkdir(join(caseDir, dir), { recursive: true })
    )
  );
}

function parseJsonlLines(text: string): JsonObject[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line) as JsonObject;
      } catch (error) {
        throw new Error(`Invalid JSONL at line ${index + 1}: ${(error as Error).message}`);
      }
    });
}

function valueToText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(valueToText).filter(Boolean).join("\n");
  }
  if (value && typeof value === "object") {
    const object = value as JsonObject;
    if (typeof object.text === "string") {
      return object.text;
    }
    if (typeof object.content === "string") {
      return object.content;
    }
    if (Array.isArray(object.content)) {
      return valueToText(object.content);
    }
  }
  return "";
}

type ExtractedCodexSession = {
  meta: JsonObject;
  userMessages: string[];
  assistantMessages: string[];
  toolCalls: JsonObject[];
  errorRecords: JsonObject[];
  approvalSandboxRecords: JsonObject[];
  touchedFiles: string[];
  timeline: string[];
};

type CaptureSubject = {
  sourceRepoRoot: string;
  sourceCwd: string;
  warnings: string[];
};

function extractCodexSession(records: JsonObject[]): ExtractedCodexSession {
  const meta = extractSessionMeta(records);
  const userMessages: string[] = [];
  const assistantMessages: string[] = [];
  const toolCalls: JsonObject[] = [];
  const errorRecords: JsonObject[] = [];
  const approvalSandboxRecords: JsonObject[] = [];
  const touched = new Set<string>();
  const timeline: string[] = [];
  const callsById = new Map<string, JsonObject>();

  for (const [index, record] of records.entries()) {
    const normalized = normalizeCodexRecord(record);
    const role = normalized.role;
    const type = String(normalized.type ?? "event");
    const content = valueToText(normalized.content);
    if (role === "user" && content && !isInjectedUserContext(content)) {
      userMessages.push(content);
    }
    if (role === "assistant" && content) {
      assistantMessages.push(content);
    }
    if (isToolCallRecord(normalized)) {
      toolCalls.push(normalized);
      const callId = getCallId(normalized);
      if (callId) callsById.set(callId, normalized);
      collectTouchedPaths(normalized, touched);
    } else if (isToolCallOutputRecord(normalized)) {
      const callId = getCallId(normalized);
      const target = callId ? callsById.get(callId) : undefined;
      if (target) {
        const outputText = valueToText(normalized.output ?? normalized.content);
        if (outputText) {
          target.stdout = [String(target.stdout ?? ""), outputText].filter(Boolean).join("\n");
        }
        const exitCode = parseProcessExitCode(outputText);
        if (exitCode !== null) {
          target.exit_code = exitCode;
          target.status = exitCode === 0 ? "success" : "failed";
        }
        if (isErrorRecord(target) && !errorRecords.includes(target)) {
          errorRecords.push(target);
        }
      }
    }
    if (isErrorRecord(normalized)) {
      errorRecords.push(normalized);
    }
    if (isApprovalSandboxRecord(normalized)) {
      approvalSandboxRecords.push(normalized);
    }
    const label = role ? String(role) : type;
    timeline.push(`- ${index + 1}. ${label}${content ? `: ${content.slice(0, 200).replace(/\s+/g, " ")}` : ""}`);
  }

  return {
    meta,
    userMessages,
    assistantMessages,
    toolCalls,
    errorRecords,
    approvalSandboxRecords,
    touchedFiles: [...touched].sort(),
    timeline
  };
}

function extractSessionMeta(records: JsonObject[]): JsonObject {
  const record = records.find((item) => item.type === "session_meta" || item.type === "session");
  if (!record) return {};
  return asObject(record.payload) ?? record;
}

function normalizeCodexRecord(record: JsonObject): JsonObject {
  const payload = asObject(record.payload);
  const body = payload ?? record;
  const message = asObject(body.message) ?? asObject(record.message);
  const item = asObject(body.item) ?? asObject(record.item);
  const rawArguments = body.arguments ?? record.arguments;
  const parsedArguments = parseToolArguments(rawArguments);
  const normalized: JsonObject = {
    ...body,
    type: body.type ?? record.type,
    role: body.role ?? record.role ?? message?.role,
    content: body.content ?? record.content ?? message?.content ?? item?.content,
    name: body.name ?? record.name,
    arguments: parsedArguments ?? rawArguments,
    call_id: body.call_id ?? record.call_id,
    status: body.status ?? record.status,
    output: body.output ?? record.output,
    stdout: body.stdout ?? record.stdout,
    stderr: body.stderr ?? record.stderr,
    exit_code: body.exit_code ?? record.exit_code ?? body.exitCode ?? record.exitCode,
    cwd: body.cwd ?? record.cwd,
    workdir: body.workdir ?? record.workdir
  };
  if (body.input !== undefined) {
    normalized.input = body.input;
  }
  return normalized;
}

function parseToolArguments(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function getCallId(record: JsonObject): string | null {
  return typeof record.call_id === "string" ? record.call_id : typeof record.callId === "string" ? record.callId : null;
}

function isToolCallRecord(record: JsonObject): boolean {
  const type = String(record.type ?? "").toLowerCase();
  return (
    type === "function_call" ||
    type === "custom_tool_call" ||
    type === "local_shell_call" ||
    type === "exec_command" ||
    (type.includes("tool") && !type.includes("output")) ||
    Boolean(record.name && (record.arguments !== undefined || record.input !== undefined)) ||
    Boolean(record.arguments !== undefined && !type.includes("output"))
  );
}

function isToolCallOutputRecord(record: JsonObject): boolean {
  const type = String(record.type ?? "").toLowerCase();
  return type === "function_call_output" || type === "custom_tool_call_output" || type.includes("call_output");
}

function parseProcessExitCode(text: string): number | null {
  const match = text.match(/Process exited with code\s+(-?\d+)/i);
  return match ? Number(match[1]) : null;
}

function isInjectedUserContext(content: string): boolean {
  const trimmed = content.trimStart();
  return (
    trimmed.startsWith("# AGENTS.md instructions") ||
    trimmed.startsWith("<environment_context>") ||
    trimmed.startsWith("<turn_aborted>")
  );
}

function collectTouchedPaths(record: JsonObject, touched: Set<string>): void {
  const serialized = JSON.stringify(record);
  for (const match of serialized.matchAll(/(?:path|file|cwd|workdir)"?\s*[:=]\s*"([^"\n]+)"/g)) {
    touched.add(match[1]);
  }
  const text = [String(record.input ?? ""), commandText(record)].join("\n");
  for (const match of text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
    touched.add(match[1].trim());
  }
}

function isErrorRecord(record: JsonObject): boolean {
  const status = String(record.status ?? record.outcome ?? "").toLowerCase();
  const exitCode = record.exit_code ?? record.exitCode;
  return (
    status === "failed" ||
    status === "error" ||
    (typeof exitCode === "number" && exitCode !== 0) ||
    (typeof record.stderr === "string" && record.stderr.length > 0 && status !== "success")
  );
}

function isApprovalSandboxRecord(record: JsonObject): boolean {
  const serialized = JSON.stringify(record).toLowerCase();
  return serialized.includes("approval") || serialized.includes("sandbox");
}

async function findSessionFromIndex(options: { cwd: string; sessionId?: string; home: string }): Promise<string> {
  const indexPath = join(options.home, ".codex", "session_index.jsonl");
  if (!(await pathExists(indexPath)) && !options.sessionId) {
    throw new Error(`Codex session index not found: ${indexPath}`);
  }
  const currentRepo = resolveGitRoot(options.cwd);
  const entries = (await pathExists(indexPath)) ? parseJsonlLines(await readFile(indexPath, "utf8")) : [];
  const candidates: { path: string; updatedAt: number }[] = [];
  const scannedPaths = new Set<string>();

  async function considerPath(candidatePath: string, entry: JsonObject = {}): Promise<void> {
    if (!candidatePath) {
      return;
    }
    const expandedPath = expandHome(candidatePath, options.home);
    if (scannedPaths.has(expandedPath)) {
      return;
    }
    scannedPaths.add(expandedPath);
    try {
      const records = parseJsonlLines(await readFile(expandedPath, "utf8"));
      const extracted = extractCodexSession(records);
      const sessionCwd = String(extracted.meta.cwd ?? entry.cwd ?? "");
      const sessionId = String(extracted.meta.id ?? entry.id ?? "");
      if (options.sessionId && !sessionId.includes(options.sessionId) && !expandedPath.includes(options.sessionId)) {
        return;
      }
      if (options.sessionId || (sessionCwd && resolveGitRoot(sessionCwd) === currentRepo)) {
        const time = Date.parse(
          String(entry.updated_at ?? entry.timestamp ?? extracted.meta.updated_at ?? extracted.meta.timestamp ?? 0)
        );
        candidates.push({ path: expandedPath, updatedAt: Number.isFinite(time) ? time : 0 });
      }
    } catch {
      return;
    }
  }

  for (const entry of entries) {
    const candidatePath = String(entry.path ?? entry.session_path ?? entry.file ?? "");
    if (options.sessionId && !JSON.stringify(entry).includes(options.sessionId)) {
      continue;
    }
    await considerPath(candidatePath, entry);
  }

  if (options.sessionId && candidates.length === 0) {
    for (const candidatePath of await findCodexSessionFiles(options.home)) {
      await considerPath(candidatePath);
    }
  }

  candidates.sort((a, b) => b.updatedAt - a.updatedAt);
  if (!candidates[0]) {
    throw new Error("No matching Codex session found for current Git repository. Use --input <jsonl>.");
  }
  return candidates[0].path;
}

async function findCodexSessionFiles(home: string): Promise<string[]> {
  const root = join(home, ".codex", "sessions");
  if (!(await pathExists(root))) {
    return [];
  }
  const files: string[] = [];
  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(path);
      }
    }
  }
  await visit(root);
  return files;
}

function resolveGitRootOrNull(cwdInput: string): string | null {
  try {
    return resolveGitRoot(cwdInput);
  } catch {
    return null;
  }
}

function resolveCaptureSubject(cwd: string, meta: JsonObject, home: string): CaptureSubject {
  const warnings: string[] = [];
  const sessionCwd = typeof meta.cwd === "string" ? absolutePath(meta.cwd, cwd, home) : null;
  if (sessionCwd) {
    const sessionRepo = resolveGitRootOrNull(sessionCwd);
    if (sessionRepo) {
      return { sourceRepoRoot: sessionRepo, sourceCwd: sessionCwd, warnings };
    }
    warnings.push(`Session cwd is not inside a Git repository, using capture cwd instead: ${sessionCwd}`);
  } else {
    warnings.push("Session cwd was not captured, using capture cwd for the subject repository.");
  }
  const sourceRepoRoot = resolveGitRoot(cwd);
  return { sourceRepoRoot, sourceCwd: cwd, warnings };
}

function detectSetupCommands(repoRoot: string): JsonObject[] {
  if (!existsSync(join(repoRoot, "package.json"))) {
    return [];
  }
  if (existsSync(join(repoRoot, "bun.lock")) || existsSync(join(repoRoot, "bun.lockb"))) {
    return [{ command: "bun install --frozen-lockfile", cwd: ".", timeoutSeconds: 300 }];
  }
  if (existsSync(join(repoRoot, "pnpm-lock.yaml"))) {
    return [{ command: "pnpm install --frozen-lockfile", cwd: ".", timeoutSeconds: 300 }];
  }
  if (existsSync(join(repoRoot, "package-lock.json"))) {
    return [{ command: "npm ci", cwd: ".", timeoutSeconds: 300 }];
  }
  if (existsSync(join(repoRoot, "yarn.lock"))) {
    return [{ command: "yarn install --frozen-lockfile", cwd: ".", timeoutSeconds: 300 }];
  }
  return [];
}

export async function captureCodexSession(options: CaptureOptions = {}): Promise<CaptureResult> {
  const cwd = absolutePath(options.cwd ?? process.cwd());
  const home = options.home ?? homedir();
  const workspaceRoot = options.workspaceRoot
    ? absolutePath(options.workspaceRoot, cwd, home)
    : await resolveWorkspaceRoot({ cwd, home, createDefault: options.yes });
  await assertWorkspace(workspaceRoot);
  const inputPath = options.input ? absolutePath(options.input, cwd, home) : await findSessionFromIndex({ cwd, sessionId: options.sessionId, home });
  const rawText = await readFile(inputPath, "utf8");
  const records = parseJsonlLines(rawText);
  const extracted = extractCodexSession(records);
  const meta = extracted.meta;
  const subject = resolveCaptureSubject(cwd, meta, home);
  const sourceRepoRoot = subject.sourceRepoRoot;
  const rawTitle = options.title ?? selectedTaskTitle(extracted) ?? "codex session capture";
  const caseId = makeCaseId(rawTitle, options.now);
  const slug = caseId.match(/^case_(.*)_\d{8}T\d{6}Z$/)?.[1] ?? slugify(rawTitle);
  const gitMeta = meta.git && typeof meta.git === "object" ? (meta.git as JsonObject) : undefined;
  const baselineCommit = typeof gitMeta?.commit_hash === "string" ? gitMeta.commit_hash : getHeadCommit(sourceRepoRoot);
  const branchAtCapture = typeof gitMeta?.branch === "string" ? gitMeta.branch : getBranch(sourceRepoRoot);
  const capturePlan: CapturePlan = {
    inputPath,
    sourceRepoRoot,
    baselineCommit,
    title: rawTitle,
    sessionId: String(meta.id ?? options.sessionId ?? basename(inputPath)),
    sessionCwd: typeof meta.cwd === "string" ? meta.cwd : null,
    model: typeof meta.model === "string" ? meta.model : null
  };
  if (!options.yes) {
    const confirmed = options.confirm ? await options.confirm(capturePlan) : await confirmCapturePlan(capturePlan);
    if (!confirmed) {
      throw new Error("Capture cancelled");
    }
  }
  const { repoId, ref } = syncRepoCache(workspaceRoot, sourceRepoRoot, baselineCommit, caseId);
  const transactionRoot = pbenchCaptureRoot(home);
  await mkdir(transactionRoot, { recursive: true });
  const transactionPath = await mkdtemp(join(transactionRoot, `tx_${slug}_${stamp(options.now)}_`));
  const caseDir = join(transactionPath, "case");
  await ensureCaseSkeleton(caseDir);
  await mkdir(join(transactionPath, "replay"), { recursive: true });

  const createdAt = nowIso(options.now);
  const replayRequirements = defaultReplayRequirements();
  const manifest = {
    $schema: "https://personal-bench.local/schemas/case.schema.json",
    schemaVersion: 1,
    id: caseId,
    title: rawTitle,
    status: "active",
    privacy: { level: "private" },
    metadata: {
      domain: "Context/Harness Engineering",
      taskTypes: ["coding-agent", "context-capture"],
      tags: ["codex", "capture", "git-baseline"],
      createdAt,
      source: { kind: "codex-session", sessionId: String(meta.id ?? options.sessionId ?? basename(inputPath)) }
    },
    documents: {
      prompt: "public/prompt.md",
      context: "public/context.md",
      environment: "public/environment.md",
      replay: "public/replay.md",
      replayManifest: PUBLIC_REPLAY_MANIFEST_PATH,
      contextManifest: PUBLIC_CONTEXT_MANIFEST_PATH,
      agentInstructions: "public/agent-instructions.md",
      keyObservations: PUBLIC_KEY_OBSERVATIONS_PATH,
      commandObservations: PUBLIC_COMMAND_OBSERVATIONS_PATH,
      failure: "private/failure.md",
      failureDraft: "private/failure-draft.md",
      successCriteria: "private/success.md",
      verification: "private/verification.md"
    },
    subjects: [
      {
        id: "main",
        type: "git-repository",
        repoId,
        sourceRootAtCapture: sourceRepoRoot,
        repositoryUrl: getOrigin(sourceRepoRoot),
        baseline: { commit: baselineCommit, ref, branchAtCapture }
      }
    ],
    setupCommands: detectSetupCommands(sourceRepoRoot),
    validators: [
      {
        id: "completion",
        type: "script",
        purpose: "completion",
        path: "private/validators/check-completion.mjs",
        cwd: ".",
        timeoutSeconds: 120,
        baselineExpected: "fail"
      }
    ],
    replayRequirements
  };
  const authoring = buildAuthoringArtifacts(rawTitle, extracted);
  const sanitizePublicText = makePublicReplaySanitizer({
    sourceRepoRoot,
    captureCwd: subject.sourceCwd,
    caseDir,
    inputPath
  });

  await writeJson(join(caseDir, "case.json"), manifest);
  await writeFile(
    join(caseDir, "README.md"),
    `# ${rawTitle}\n\nGenerated by yk pbench capture. Review generated authoring docs, finish the completion validator if needed, then run strict validation.\n`
  );
  await writeFile(join(caseDir, "public", "prompt.md"), sanitizePublicText(`${extracted.userMessages[0] ?? ""}\n`));
  await writeFile(
    join(caseDir, "public", "context.md"),
    sanitizePublicText(
      [
        `Subject repo at capture: ${sourceRepoRoot}`,
        `Session cwd: ${String(meta.cwd ?? "unknown")}`,
        `Session id: ${String(meta.id ?? options.sessionId ?? basename(inputPath))}`,
        `Baseline commit: ${baselineCommit}`,
        `Branch at capture: ${String(branchAtCapture ?? "unknown")}`,
        ""
      ].join("\n")
    )
  );
  await writeFile(join(caseDir, "public", "environment.md"), `Captured at: ${createdAt}\nModel: ${String(meta.model ?? "unknown")}\n`);
  await writeFile(join(caseDir, "private", "failure.md"), authoring.failure);
  await writeFile(join(caseDir, "private", "success.md"), authoring.success);
  await writeFile(join(caseDir, "private", "verification.md"), authoring.verification);
  await writeFile(join(caseDir, "private", "validators", "check-completion.mjs"), authoring.validatorScript);
  await writeFile(join(caseDir, "private", "artifacts", "raw", "codex-session.jsonl"), rawText);
  await writeFile(join(caseDir, "private", "artifacts", "extracted", "original-prompt.md"), `${extracted.userMessages.join("\n\n---\n\n")}\n`);
  await writeFile(join(caseDir, "private", "artifacts", "extracted", "timeline.md"), `${extracted.timeline.join("\n")}\n`);
  await writeJson(join(caseDir, "private", "artifacts", "extracted", "session-summary.json"), {
    metadata: meta,
    userMessageCount: extracted.userMessages.length,
    assistantMessageCount: extracted.assistantMessages.length,
    toolCallCount: extracted.toolCalls.length,
    errorCount: extracted.errorRecords.length,
    approvalSandboxRecordCount: extracted.approvalSandboxRecords.length,
    touchedFileCount: extracted.touchedFiles.length
  });
  await writeJson(join(caseDir, "private", "artifacts", "extracted", "tool-calls.json"), extracted.toolCalls);
  await writeJson(join(caseDir, "private", "artifacts", "extracted", "errors.json"), extracted.errorRecords);
  await writeJson(join(caseDir, "private", "artifacts", "extracted", "approval-sandbox.json"), {
    metadata: {
      sandboxMode: meta.sandbox_mode ?? meta.sandboxMode ?? null,
      approvalPolicy: meta.approval_policy ?? meta.approvalPolicy ?? null,
      cliVersion: meta.cli_version ?? meta.cliVersion ?? null,
      timestamp: meta.timestamp ?? meta.created_at ?? meta.createdAt ?? null,
      updatedAt: meta.updated_at ?? meta.updatedAt ?? null
    },
    records: extracted.approvalSandboxRecords
  });
  await writeJson(join(caseDir, "private", "artifacts", "extracted", "touched-files.json"), extracted.touchedFiles);
  await writeReplayContext({
    caseDir,
    caseId,
    title: rawTitle,
    createdAt,
    sourceRepoRoot,
    captureCwd: subject.sourceCwd,
    baselineCommit,
    setupCommands: manifest.setupCommands,
    extracted,
    replayRequirements,
    sanitizePublicText
  });
  await writeJson(join(transactionPath, "transaction.json"), {
    schemaVersion: 1,
    transactionPath,
    workspaceRoot,
    caseDir,
    caseId,
    sourceRoot: sourceRepoRoot,
    source: { kind: "codex-session", inputPath },
    createdAt,
    strictValidatedAt: null
  });

  return { transactionPath, caseDir, caseId, workspaceRoot, warnings: subject.warnings };
}

function selectedTaskTitle(extracted: ExtractedCodexSession): string | null {
  const first = extracted.userMessages[0]?.split(/\r?\n/)[0]?.trim();
  return first ? first.slice(0, 80) : null;
}

type GeneratedAuthoringArtifacts = {
  failure: string;
  success: string;
  verification: string;
  validatorScript: string;
};

type VerificationCommand = {
  command: string;
  cwd: string;
  stderr: string;
  stdout: string;
};

function buildAuthoringArtifacts(title: string, extracted: ExtractedCodexSession): GeneratedAuthoringArtifacts {
  const prompt = extracted.userMessages[0]?.trim() ?? "";
  const corrections = extracted.userMessages.slice(1).map(evidenceLine).filter(Boolean);
  const errors = extracted.errorRecords.map(errorEvidenceLine).filter(Boolean);
  const failedVerification = findFailedVerificationCommand(extracted);

  return {
    failure: renderFailureDocument(corrections, errors),
    success: renderSuccessDocument(title, prompt, corrections),
    verification: renderVerificationDocument(failedVerification),
    validatorScript: failedVerification
      ? renderCommandValidatorScript(failedVerification.command)
      : renderAuthoringRequiredValidatorScript()
  };
}

function renderFailureDocument(corrections: string[], errors: string[]): string {
  const lines = ["# Failure", "", "Generated from captured Codex session history.", ""];
  if (corrections.length > 0) {
    lines.push("## User Correction Evidence", "");
    lines.push(...corrections.map((message) => `- ${message}`), "");
  }
  if (errors.length > 0) {
    lines.push("## Command/Error Evidence", "");
    lines.push(...errors.map((message) => `- ${message}`), "");
  }
  if (corrections.length === 0 && errors.length === 0) {
    lines.push("No failure evidence was detected in the captured session. Ask for the task/session-level outcome mismatch before finalizing.", "");
  }
  return `${lines.join("\n")}\n`;
}

function renderSuccessDocument(title: string, prompt: string, corrections: string[]): string {
  const lines = ["# Success Criteria", "", "Generated from captured Codex session history.", ""];
  const task = prompt || title;
  if (task) {
    lines.push("A future agent succeeds when it completes the captured task:", "", `- ${evidenceLine(task)}`, "");
  } else {
    lines.push("No original task prompt was captured. Ask for observable success criteria before finalizing.", "");
  }
  if (corrections.length > 0) {
    lines.push("It must also resolve the captured correction evidence:", "");
    lines.push(...corrections.map((message) => `- ${message}`), "");
  }
  lines.push("Completion must be demonstrated by the completion validator.");
  return `${lines.join("\n")}\n`;
}

function renderVerificationDocument(command: VerificationCommand | null): string {
  const lines = ["# Verification", "", "Generated from captured Codex session history.", ""];
  if (command) {
    lines.push(
      "The completion validator reruns the failed verification command captured in the original session:",
      "",
      `- command: \`${command.command}\``,
      `- cwd: ${command.cwd}`,
      "- pass condition: exit code 0",
      ""
    );
    if (command.stderr) {
      lines.push("Captured failure stderr:", "", fenced(command.stderr), "");
    }
    if (command.stdout) {
      lines.push("Captured failure stdout:", "", fenced(command.stdout), "");
    }
  } else {
    lines.push(
      "No failed verification command was detected. The current pbench-authoring agent must implement the completion validator from the correction evidence before strict validation.",
      "",
      "Use `private/failure.md`, `private/success.md`, and the raw session transcript to choose an observable replay check."
    );
  }
  return `${lines.join("\n")}\n`;
}

function findFailedVerificationCommand(extracted: ExtractedCodexSession): VerificationCommand | null {
  const candidates: VerificationCommand[] = [];
  for (const record of extracted.errorRecords) {
    const command = commandText(record).trim();
    if (!isReplayableVerificationCommand(command)) {
      continue;
    }
    const args = asObject(record.arguments) ?? {};
    candidates.push({
      command,
      cwd: String(args.cwd ?? args.workdir ?? record.cwd ?? record.workdir ?? "."),
      stdout: excerpt(String(record.stdout ?? ""), 1000),
      stderr: excerpt(String(record.stderr ?? ""), 1000)
    });
  }
  return candidates[candidates.length - 1] ?? null;
}

function isReplayableVerificationCommand(command: string): boolean {
  if (!command) return false;
  if (/[;&|<>`$]/.test(command)) return false;
  if (!/^(bun|npm|pnpm|yarn)\b/.test(command)) return false;
  return /\b(test|typecheck|build|lint|check|verify)\b/.test(command);
}

function renderCommandValidatorScript(command: string): string {
  return [
    "import { spawnSync } from 'node:child_process';",
    "",
    `const command = ${JSON.stringify(command)};`,
    "const result = spawnSync(command, {",
    "  cwd: process.cwd(),",
    "  shell: true,",
    "  encoding: 'utf8',",
    "  env: process.env",
    "});",
    "",
    "if (result.stdout) process.stdout.write(result.stdout);",
    "if (result.stderr) process.stderr.write(result.stderr);",
    "if (result.error) console.error(result.error.message);",
    "const exitCode = result.status ?? (result.signal ? 124 : 1);",
    "process.exit(exitCode === 0 ? 0 : 1);",
    ""
  ].join("\n");
}

function renderAuthoringRequiredValidatorScript(): string {
  return [
    `console.error('${VALIDATOR_AUTHORING_SENTINEL}: implement completion validator from captured correction evidence.');`,
    "console.error('Read private/failure.md, private/success.md, private/verification.md, and private/artifacts/raw/codex-session.jsonl.');",
    "process.exit(2);",
    ""
  ].join("\n");
}

function evidenceLine(text: string): string {
  return excerpt(text.replace(/\s+/g, " ").trim(), 500);
}

function errorEvidenceLine(record: JsonObject): string {
  const command = commandText(record);
  const exitCode = record.exit_code ?? record.exitCode ?? "unknown";
  const stderrText = evidenceLine(String(record.stderr ?? ""));
  const stdoutText = evidenceLine(String(record.stdout ?? ""));
  return [command ? `${command}:` : "", `exitCode=${String(exitCode)}`, stderrText ? `stderr=${stderrText}` : "", stdoutText ? `stdout=${stdoutText}` : ""]
    .filter(Boolean)
    .join(" ");
}

type ReplayContextOptions = {
  caseDir: string;
  caseId: string;
  title: string;
  createdAt: string;
  sourceRepoRoot: string;
  captureCwd: string;
  baselineCommit: string;
  setupCommands: JsonObject[];
  extracted: ExtractedCodexSession;
  replayRequirements: ReplayRequirements;
  sanitizePublicText: (text: string) => string;
};

type PublicContextFile = {
  source: string;
  publicPath: string;
  kind: "untracked";
};

async function writeReplayContext(options: ReplayContextOptions): Promise<void> {
  const warnings: string[] = [];
  const agentInstructionsPath = await writeAgentInstructions(
    options.caseDir,
    options.sourceRepoRoot,
    options.captureCwd,
    options.sanitizePublicText
  );
  const keyObservationsPath = await writeKeyObservations(options.caseDir, options.extracted, options.sanitizePublicText);
  const commandObservationsPath = await writeCommandObservations(options.caseDir, options.extracted, options.sanitizePublicText);
  const startingPatchPath = await writeStartingPatch(options.caseDir, options.sourceRepoRoot, warnings);
  const contextFiles = await writeUntrackedContextFiles(options.caseDir, options.sourceRepoRoot, warnings);
  await writeFailureDraft(options.caseDir, options.extracted);

  const replayFiles = {
    replay: "public/replay.md",
    replayManifest: PUBLIC_REPLAY_MANIFEST_PATH,
    contextManifest: PUBLIC_CONTEXT_MANIFEST_PATH,
    agentInstructions: agentInstructionsPath,
    keyObservations: keyObservationsPath,
    commandObservations: commandObservationsPath,
    startingPatch: startingPatchPath
  };
  const contextManifest = {
    schemaVersion: 1,
    caseId: options.caseId,
    title: options.title,
    createdAt: options.createdAt,
    source: {
      kind: "codex-session",
      sessionId: String(options.extracted.meta.id ?? ""),
      cwd: typeof options.extracted.meta.cwd === "string" ? options.sanitizePublicText(options.extracted.meta.cwd) : null,
      model: options.extracted.meta.model ?? null
    },
    baseline: {
      repoRoot: SUBJECT_REPO_PLACEHOLDER,
      commit: options.baselineCommit
    },
    packageManager: inferPackageManager(options.setupCommands),
    setupCommands: options.setupCommands,
    replayFiles,
    contextFiles,
    replayRequirements: options.replayRequirements,
    warnings
  };

  await writeJson(join(options.caseDir, PUBLIC_CONTEXT_MANIFEST_PATH), contextManifest);
  await writeJson(join(options.caseDir, PUBLIC_REPLAY_MANIFEST_PATH), contextManifest);
  await writeFile(
    join(options.caseDir, "public", "replay.md"),
    options.sanitizePublicText(renderReplayMarkdown(options, replayFiles, contextFiles, warnings))
  );
}

function inferPackageManager(setupCommands: JsonObject[]): string | null {
  const command = String(setupCommands[0]?.command ?? "");
  if (command.startsWith("bun ")) return "bun";
  if (command.startsWith("pnpm ")) return "pnpm";
  if (command.startsWith("npm ")) return "npm";
  if (command.startsWith("yarn ")) return "yarn";
  return null;
}

function renderReplayMarkdown(
  options: ReplayContextOptions,
  replayFiles: Record<string, string | null>,
  contextFiles: PublicContextFile[],
  warnings: string[]
): string {
  const setup = options.setupCommands.map((item) => `- ${String(item.command)} (cwd: ${String(item.cwd ?? ".")})`).join("\n") || "- No setup command detected.";
  const fileLines = contextFiles.map((file) => `- ${file.publicPath} (from ${file.source})`).join("\n") || "- No untracked context files captured.";
  const warningLines = warnings.map((warning) => `- ${warning}`).join("\n") || "- No replay warnings.";
  const patchLine = replayFiles.startingPatch ? `Apply starting patch from \`${replayFiles.startingPatch}\` before attempting the task.` : "No tracked dirty starting patch was captured.";
  return [
    `# ${options.title}`,
    "",
    "## Task",
    "",
    "Read `public/prompt.md` first. Use this replay file as the context index for the benchmark task.",
    "",
    "## Baseline",
    "",
    `- Repo root at capture: ${options.sourceRepoRoot}`,
    `- Baseline commit: ${options.baselineCommit}`,
    `- Replay manifest: ${String(replayFiles.replayManifest)}`,
    "",
    "## Setup",
    "",
    setup,
    "",
    "## Starting State",
    "",
    patchLine,
    "",
    "## Agent Instructions",
    "",
    `Read \`${String(replayFiles.agentInstructions)}\` for repo-visible agent instructions and installed skill names.`,
    "",
    "## Key Observations",
    "",
    `Read \`${String(replayFiles.keyObservations)}\` first for filtered failure and verification evidence.`,
    `Use \`${String(replayFiles.commandObservations)}\` only as supporting command/tool context.`,
    "",
    "## Context Files",
    "",
    fileLines,
    "",
    "## Warnings",
    "",
    warningLines,
    "",
    "Use only files listed in the public replay capsule while working the replay task."
  ].join("\n");
}

async function writeAgentInstructions(
  caseDir: string,
  repoRoot: string,
  captureCwd: string,
  sanitizePublicText: (text: string) => string
): Promise<string> {
  const lines = ["# Agent Instructions", ""];
  const instructionFiles = agentInstructionCandidates(repoRoot, captureCwd);
  for (const file of instructionFiles) {
    if (!(await pathExists(file))) continue;
    const relativePath = relativePathFrom(repoRoot, file);
    lines.push(`## ${relativePath}`, "", await readFile(file, "utf8"), "");
  }
  if (instructionFiles.length === 0 || lines.length === 2) {
    lines.push("No AGENTS.md files found between repo root and capture cwd.", "");
  }

  for (const root of [".agents/skills", ".claude/skills"]) {
    const skills = await listSkillNames(join(repoRoot, root));
    lines.push(`## ${root}`, "", skills.length > 0 ? `${root}: ${skills.join(", ")}` : `${root}: none detected`, "");
  }

  const publicPath = "public/agent-instructions.md";
  await writeFile(join(caseDir, publicPath), sanitizePublicText(lines.join("\n")));
  return publicPath;
}

function agentInstructionCandidates(repoRoot: string, captureCwd: string): string[] {
  const resolvedRepo = resolve(repoRoot);
  const resolvedCwd = resolve(captureCwd);
  const relativeCwd = relative(resolvedRepo, resolvedCwd);
  const parts = relativeCwd && !relativeCwd.startsWith("..") ? relativeCwd.split(sep).filter(Boolean) : [];
  const dirs = [resolvedRepo];
  for (let index = 1; index <= parts.length; index += 1) {
    dirs.push(join(resolvedRepo, ...parts.slice(0, index)));
  }
  return dirs.map((dir) => join(dir, "AGENTS.md"));
}

async function listSkillNames(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort((a, b) => a.localeCompare(b));
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }
}

async function writeKeyObservations(
  caseDir: string,
  extracted: ExtractedCodexSession,
  sanitizePublicText: (text: string) => string
): Promise<string> {
  const lines = ["# Key Observations", ""];
  const commandRecords = extracted.toolCalls.filter((record) => commandText(record)).filter(isKeyObservationRecord);
  if (commandRecords.length === 0) {
    lines.push("No key command observations captured.", "");
  }
  for (const [index, record] of commandRecords.entries()) {
    const args = asObject(record.arguments) ?? {};
    lines.push(`## ${index + 1}. ${sanitizePublicText(commandText(record))}`, "");
    lines.push(`- cwd: ${sanitizePublicText(String(args.cwd ?? args.workdir ?? record.cwd ?? record.workdir ?? "unknown"))}`);
    lines.push(`- status: ${String(record.status ?? record.outcome ?? "unknown")}`);
    lines.push(`- exitCode: ${String(record.exit_code ?? record.exitCode ?? "unknown")}`);
    const stdoutText = excerpt(sanitizePublicText(String(record.stdout ?? "")));
    const stderrText = excerpt(sanitizePublicText(String(record.stderr ?? "")));
    if (stdoutText) lines.push("", "stdout:", fenced(stdoutText));
    if (stderrText) lines.push("", "stderr:", fenced(stderrText));
    lines.push("");
  }
  await writeFile(join(caseDir, PUBLIC_KEY_OBSERVATIONS_PATH), lines.join("\n"));
  return PUBLIC_KEY_OBSERVATIONS_PATH;
}

function isKeyObservationRecord(record: JsonObject): boolean {
  const command = commandText(record).trim();
  if (!command || isSkippedObservationCommand(command)) {
    return false;
  }
  const status = String(record.status ?? record.outcome ?? "").toLowerCase();
  const exitCode = record.exit_code ?? record.exitCode;
  const failed =
    status === "failed" ||
    status === "error" ||
    (typeof exitCode === "number" && exitCode !== 0) ||
    (typeof exitCode === "string" && exitCode.length > 0 && exitCode !== "0" && exitCode !== "unknown");
  return failed || isReplayableVerificationCommand(command);
}

function isSkippedObservationCommand(command: string): boolean {
  const lower = command.toLowerCase();
  if (lower.includes("yk pbench capture") || lower.includes("yk pbench validate") || lower.includes("yk pbench finalize")) {
    return true;
  }
  if (lower.includes("yk pbench export-replay")) {
    return true;
  }
  if (lower.includes("superpowers") && (lower.includes("use-skill") || lower.includes("bootstrap") || lower.includes("/skills/"))) {
    return true;
  }
  if (lower.includes("/skills/") && lower.includes("skill.md") && /^(sed|cat|bat|less)\b/.test(lower)) {
    return true;
  }
  return false;
}

async function writeCommandObservations(
  caseDir: string,
  extracted: ExtractedCodexSession,
  sanitizePublicText: (text: string) => string
): Promise<string> {
  const lines = ["# Command Observations", ""];
  const commandRecords = extracted.toolCalls.filter((record) => commandText(record));
  if (commandRecords.length === 0) {
    lines.push("No command-like tool calls captured.", "");
  }
  for (const [index, record] of commandRecords.entries()) {
    const args = asObject(record.arguments) ?? {};
    lines.push(`## ${index + 1}. ${sanitizePublicText(commandText(record))}`, "");
    lines.push(`- cwd: ${sanitizePublicText(String(args.cwd ?? args.workdir ?? record.cwd ?? record.workdir ?? "unknown"))}`);
    lines.push(`- status: ${String(record.status ?? record.outcome ?? "unknown")}`);
    lines.push(`- exitCode: ${String(record.exit_code ?? record.exitCode ?? "unknown")}`);
    const stdoutText = excerpt(sanitizePublicText(String(record.stdout ?? "")));
    const stderrText = excerpt(sanitizePublicText(String(record.stderr ?? "")));
    if (stdoutText) lines.push("", "stdout:", fenced(stdoutText));
    if (stderrText) lines.push("", "stderr:", fenced(stderrText));
    lines.push("");
  }
  await writeFile(join(caseDir, PUBLIC_COMMAND_OBSERVATIONS_PATH), lines.join("\n"));
  return PUBLIC_COMMAND_OBSERVATIONS_PATH;
}

function commandText(record: JsonObject): string {
  const args = asObject(record.arguments) ?? {};
  return String(args.cmd ?? args.command ?? record.command ?? "");
}

function fenced(text: string): string {
  return ["```text", text, "```"].join("\n");
}

function excerpt(text: string, maxLength = 2000): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n[truncated]` : text;
}

async function writeStartingPatch(caseDir: string, repoRoot: string, warnings: string[]): Promise<string | null> {
  const patch = execGitRawOptional(repoRoot, ["diff", "--binary", "HEAD", "--", "."]);
  if (!patch) return null;
  if (Buffer.byteLength(patch, "utf8") > MAX_PUBLIC_PATCH_BYTES) {
    await writeFile(join(caseDir, "private", "artifacts", "extracted", "starting.patch"), patch);
    warnings.push("Tracked dirty patch exceeded public size limit and was saved as private/artifacts/extracted/starting.patch.");
    return null;
  }
  const publicPath = "public/starting.patch";
  await writeFile(join(caseDir, publicPath), patch);
  return publicPath;
}

async function writeUntrackedContextFiles(caseDir: string, repoRoot: string, warnings: string[]): Promise<PublicContextFile[]> {
  const files = execGitOptional(repoRoot, ["ls-files", "--others", "--exclude-standard"])
    .split(/\r?\n/)
    .map((file) => file.trim())
    .filter(Boolean);
  const copied: PublicContextFile[] = [];
  for (const file of files) {
    if (!safeRelativePath(file) || file.startsWith(".git/")) {
      warnings.push(`Skipped unsafe untracked path: ${file}`);
      continue;
    }
    const sourcePath = join(repoRoot, file);
    const info = await stat(sourcePath).catch(() => null);
    if (!info?.isFile()) continue;
    if (info.size > MAX_PUBLIC_TEXT_FILE_BYTES) {
      warnings.push(`Skipped large untracked file: ${file}`);
      continue;
    }
    const bytes = await readFile(sourcePath);
    if (!isUtf8Text(bytes)) {
      warnings.push(`Skipped binary untracked file: ${file}`);
      continue;
    }
    const publicPath = `public/context-files/untracked/${file.replace(/\\/g, "/")}`;
    await mkdir(dirname(join(caseDir, publicPath)), { recursive: true });
    await writeFile(join(caseDir, publicPath), bytes);
    copied.push({ source: file.replace(/\\/g, "/"), publicPath, kind: "untracked" });
  }
  return copied;
}

function isUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    TEXT_DECODER.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

async function writeFailureDraft(caseDir: string, extracted: ExtractedCodexSession): Promise<void> {
  const laterUserMessages = extracted.userMessages.slice(1);
  const lines = ["# Failure Draft", "", "This draft is generated from deterministic capture heuristics. Rewrite `private/failure.md` with the final failure statement.", ""];
  if (laterUserMessages.length > 0) {
    lines.push("## Later User Corrections", "");
    for (const message of laterUserMessages) {
      lines.push(`- ${message.replace(/\s+/g, " ").trim()}`);
    }
    lines.push("");
  }
  if (extracted.errorRecords.length > 0) {
    lines.push("## Error Records", "");
    for (const record of extracted.errorRecords) {
      const command = commandText(record);
      const exitCode = record.exit_code ?? record.exitCode ?? "unknown";
      const stderrText = excerpt(String(record.stderr ?? ""), 500).replace(/\s+/g, " ").trim();
      lines.push(`- ${command ? `${command}: ` : ""}exitCode=${String(exitCode)}${stderrText ? ` stderr=${stderrText}` : ""}`);
    }
    lines.push("");
  }
  if (laterUserMessages.length === 0 && extracted.errorRecords.length === 0) {
    lines.push("No obvious user correction or command failure was detected. Inspect the raw transcript before finalizing the case.", "");
  }
  await writeFile(join(caseDir, "private", "failure-draft.md"), lines.join("\n"));
}

function execGitOptional(cwd: string, args: string[]): string {
  try {
    return execGit(cwd, args);
  } catch {
    return "";
  }
}

function execGitRawOptional(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return "";
  }
}

function relativePathFrom(root: string, path: string): string {
  return relative(root, path).replace(/\\/g, "/");
}

function publicRepoPath(path: string, repoRoot: string): string {
  const relativePath = relative(repoRoot, path).replace(/\\/g, "/");
  if (!relativePath) {
    return SUBJECT_REPO_PLACEHOLDER;
  }
  if (!relativePath.startsWith("../") && relativePath !== ".." && !isAbsolute(relativePath)) {
    return `${SUBJECT_REPO_PLACEHOLDER}/${relativePath}`;
  }
  return PRIVATE_PATH_PLACEHOLDER;
}

function makePublicReplaySanitizer(options: {
  sourceRepoRoot: string;
  captureCwd?: string | null;
  caseDir?: string;
  inputPath?: string;
}): (text: string) => string {
  const replacements = [
    { value: options.inputPath, replacement: PRIVATE_PATH_PLACEHOLDER },
    { value: options.caseDir, replacement: PRIVATE_PATH_PLACEHOLDER },
    {
      value: options.captureCwd,
      replacement: options.captureCwd ? publicRepoPath(options.captureCwd, options.sourceRepoRoot) : undefined
    },
    { value: options.sourceRepoRoot, replacement: SUBJECT_REPO_PLACEHOLDER }
  ]
    .filter((item): item is { value: string; replacement: string } => Boolean(item.value && item.replacement))
    .sort((left, right) => right.value.length - left.value.length);

  return (text: string) => {
    let outputText = text;
    for (const { value, replacement } of replacements) {
      outputText = outputText.split(value).join(replacement);
    }
    outputText = outputText.replace(/(^|[\s"'`(=:[{])\/private(?:\/[^\s"'`)<>\]}]*)?/g, `$1${PRIVATE_PATH_PLACEHOLDER}`);
    outputText = outputText.replace(/(^|[\s"'`(=:[{])(?:\.\/)?private[\\/][^\s"'`)<>\]}]*/g, `$1${PRIVATE_PATH_PLACEHOLDER}`);
    outputText = outputText.replace(/\bPB_PRIVATE_DIR\b/g, "PB_PRIVATE_ENV");
    outputText = outputText.replace(/\bPB_CASE_DIR\b/g, "PB_CASE_ENV");
    return outputText;
  };
}

async function confirmCapturePlan(plan: CapturePlan): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new Error("Capture requires --yes in non-interactive mode.");
  }
  output.write(
    [
      "About to capture pbench case:",
      `  Session: ${plan.inputPath}`,
      `  Repo: ${plan.sourceRepoRoot}`,
      `  Baseline: ${plan.baselineCommit}`,
      `  Title: ${plan.title}`,
      ""
    ].join("\n")
  );
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question("Capture this session? [y/N] ");
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function validateAuthoringDraft(caseDir: string): Promise<ValidationResult> {
  const result = await validateCaseBundle(caseDir, { strict: false });
  const warnings = [...result.warnings, ...(await findAuthoringWarnings(caseDir))];
  return {
    ...result,
    ok: result.ok && warnings.length === 0,
    warnings
  };
}

async function findAuthoringWarnings(caseDir: string): Promise<string[]> {
  const warnings: string[] = [];
  const prompt = await readFile(join(caseDir, "public", "prompt.md"), "utf8");
  if (prompt.trim().length === 0) {
    warnings.push("public/prompt.md is empty");
  }
  const commandObservations = await readFile(join(caseDir, "public", "command-observations.md"), "utf8");
  if (commandObservations.includes("No command-like tool calls captured.")) {
    warnings.push("public/command-observations.md has no command-like tool calls");
  }
  const failureDraft = await readFile(join(caseDir, "private", "failure-draft.md"), "utf8");
  if (failureDraft.includes("No obvious user correction or command failure was detected.")) {
    warnings.push("private/failure-draft.md has no later user correction or command failure evidence");
  }
  for (const path of [
    "private/failure.md",
    "private/success.md",
    "private/verification.md",
    "private/validators/check-completion.mjs"
  ]) {
    const content = await readFile(join(caseDir, path), "utf8");
    if (content.includes("TODO")) {
      warnings.push(`${path} still contains TODO`);
    }
    if (path === "private/failure.md" && content.includes("No failure evidence was detected in the captured session.")) {
      warnings.push("private/failure.md needs failure evidence from session history");
    }
    if (path === "private/success.md" && content.includes("No original task prompt was captured.")) {
      warnings.push("private/success.md needs observable success criteria from session history");
    }
    if (path === "private/validators/check-completion.mjs" && content.includes(VALIDATOR_AUTHORING_SENTINEL)) {
      warnings.push("private/validators/check-completion.mjs needs completion logic from session correction evidence");
    }
  }
  return warnings;
}

function validatePathField(errors: string[], field: string, value: unknown): string | null {
  const safe = safeRelativePath(value);
  if (!safe) {
    errors.push(`Unsafe or invalid case-local path in ${field}: ${String(value)}`);
  }
  return safe;
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function asArray(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter((item): item is JsonObject => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function validateManifestShape(manifest: JsonObject, errors: string[]): void {
  if (manifest.schemaVersion !== 1) {
    errors.push("/schemaVersion must be 1");
  }
  if (typeof manifest.id !== "string" || !/^case_[a-z0-9-]{1,60}_[0-9]{8}T[0-9]{6}Z$/.test(manifest.id)) {
    errors.push("/id must match case_<slug>_YYYYMMDDTHHmmssZ");
  }
  if (typeof manifest.title !== "string" || manifest.title.length === 0) {
    errors.push("/title must be a non-empty string");
  }
  if (manifest.status !== "active") {
    errors.push("/status must be active");
  }
  const privacy = asObject(manifest.privacy);
  if (!privacy || privacy.level !== "private") {
    errors.push("/privacy.level must be private");
  }
  const metadata = asObject(manifest.metadata);
  if (!metadata || typeof metadata.createdAt !== "string" || !asObject(metadata.source)) {
    errors.push("/metadata must include createdAt and source");
  }
  if (!asObject(manifest.documents)) {
    errors.push("/documents must be an object");
  }
  if (asArray(manifest.subjects).length !== 1) {
    errors.push("V1 requires subjects.length === 1.");
  }
  if (asArray(manifest.validators).length < 1) {
    errors.push("At least one validator is required.");
  }
}

function requiredReplayEnv(manifest: JsonObject): string[] {
  const names = new Set<string>();
  for (const name of normalizeReplayRequirements(manifest.replayRequirements).requiredEnv) {
    names.add(name);
  }
  for (const validator of asArray(manifest.validators)) {
    if (Array.isArray(validator.requiredEnv)) {
      for (const name of validator.requiredEnv) {
        if (typeof name === "string" && name.length > 0) {
          names.add(name);
        }
      }
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

function validateRequiredReplayEnv(manifest: JsonObject, errors: string[]): void {
  const missing = requiredReplayEnv(manifest).filter((name) => !process.env[name]);
  if (missing.length > 0) {
    errors.push(`Missing required replay environment variables: ${missing.join(", ")}`);
  }
}

async function validateCasePaths(caseDir: string, manifest: JsonObject, strict: boolean, errors: string[]): Promise<void> {
  const documents = asObject(manifest.documents) ?? {};
  for (const [key, value] of Object.entries(documents)) {
    const safe = validatePathField(errors, `documents.${key}`, value);
    if (strict && safe && !(await pathExists(join(caseDir, safe)))) {
      errors.push(`Missing document ${key}: ${safe}`);
    }
  }
  for (const [index, validator] of asArray(manifest.validators).entries()) {
    if (validator.type === "script") {
      const safe = validatePathField(errors, `validators[${index}].path`, validator.path);
      if (strict && safe && !(await pathExists(join(caseDir, safe)))) {
        errors.push(`Missing validator script: ${safe}`);
      }
      if (strict && safe && (await pathExists(join(caseDir, safe)))) {
        const content = await readFile(join(caseDir, safe), "utf8");
        if (content.includes(VALIDATOR_AUTHORING_SENTINEL)) {
          errors.push(`Unimplemented completion validator: ${safe}`);
        }
      }
    }
    if (validator.cwd !== undefined) {
      validatePathField(errors, `validators[${index}].cwd`, validator.cwd);
    }
  }
}

function repoCacheForSubject(workspaceRoot: string, subject: JsonObject): string {
  return join(workspaceRoot, "repos", `${String(subject.repoId)}.git`);
}

async function createReplayWorktree(repoCache: string, commit: string, workspaceRoot: string, runId: string): Promise<string> {
  const replayRunRoot = join(workspaceRoot, ".personal-bench", "replays", runId);
  const replayRoot = join(replayRunRoot, "worktree");
  await rm(replayRunRoot, { recursive: true, force: true });
  await mkdir(replayRunRoot, { recursive: true });
  execGitDir(repoCache, ["worktree", "add", "--detach", replayRoot, commit]);
  return replayRoot;
}

async function cleanupReplayWorktree(repoCache: string, replayRoot: string): Promise<void> {
  try {
    execGitDir(repoCache, ["worktree", "remove", "--force", replayRoot]);
  } catch {
    // The directory removal below handles partially-created worktrees.
  }
  const rootToRemove = basename(replayRoot) === "worktree" ? dirname(replayRoot) : replayRoot;
  await rm(rootToRemove, { recursive: true, force: true });
}

function runShell(command: string, cwd: string, timeoutSeconds: number, env: NodeJS.ProcessEnv): ValidatorOutcome {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf8",
    timeout: timeoutSeconds * 1000,
    env
  });
  const exitCode = result.status ?? (result.signal ? 124 : null);
  return {
    id: command,
    expected: "pass",
    actual: exitCode === 0 ? "pass" : "fail",
    exitCode,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

async function runValidators(options: {
  caseDir: string;
  manifest: JsonObject;
  replayRoot: string;
  env: NodeJS.ProcessEnv;
  expectedMode: "baseline" | "candidate";
  errors: string[];
}): Promise<ValidatorOutcome[]> {
  const outcomes: ValidatorOutcome[] = [];
  const validators = asArray(options.manifest.validators);
  if (!validators.some((validator) => validator.purpose === "completion")) {
    options.errors.push("At least one completion validator is required.");
  }
  for (const validator of validators) {
    const expected =
      options.expectedMode === "candidate" ? "pass" : validator.baselineExpected === "pass" ? "pass" : "fail";
    let outcome: ValidatorOutcome;
    if (validator.type === "command") {
      const command = String(validator.command ?? "");
      const cwd = join(options.replayRoot, safeRelativePath(validator.cwd ?? ".") ?? ".");
      outcome = runShell(command, cwd, Number(validator.timeoutSeconds ?? 120), options.env);
      outcome.id = String(validator.id ?? command);
    } else {
      const scriptPath = join(options.caseDir, String(validator.path));
      await chmod(scriptPath, 0o755).catch(() => undefined);
      const cwd = join(options.replayRoot, safeRelativePath(validator.cwd ?? ".") ?? ".");
      const result = spawnSync("node", [scriptPath], {
        cwd,
        encoding: "utf8",
        timeout: Number(validator.timeoutSeconds ?? 120) * 1000,
        env: options.env
      });
      const exitCode = result.status ?? (result.signal ? 124 : null);
      outcome = {
        id: String(validator.id ?? validator.path),
        expected,
        actual: exitCode === 0 ? "pass" : "fail",
        exitCode,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? ""
      };
    }
    outcome.expected = expected;
    outcomes.push(outcome);
    if (outcome.actual !== expected) {
      const label = options.expectedMode === "baseline" ? "baseline outcome" : "candidate outcome";
      options.errors.push(`Validator ${outcome.id} ${label} ${outcome.actual}, expected ${expected}.\n${outcome.stderr || outcome.stdout}`);
    }
  }
  return outcomes;
}

async function runStrictValidation(
  caseDir: string,
  manifest: JsonObject,
  workspaceRoot: string,
  errors: string[]
): Promise<ValidatorOutcome[]> {
  const subject = asArray(manifest.subjects)[0];
  if (!subject) {
    errors.push("V1 requires exactly one git subject.");
    return [];
  }
  const baseline = asObject(subject.baseline);
  const commit = String(baseline?.commit ?? "");
  const repoCache = repoCacheForSubject(workspaceRoot, subject);
  if (!(await pathExists(repoCache))) {
    errors.push(`Missing repo cache: ${repoCache}`);
    return [];
  }
  try {
    execGitDir(repoCache, ["cat-file", "-e", `${commit}^{commit}`]);
  } catch {
    errors.push(`Baseline commit not present in repo cache: ${commit}`);
    return [];
  }
  if (baseline?.ref) {
    try {
      const refCommit = execGitDir(repoCache, ["rev-parse", String(baseline.ref)]);
      if (refCommit !== commit) {
        errors.push(`Baseline ref ${String(baseline.ref)} points to ${refCommit}, expected ${commit}`);
      }
    } catch {
      errors.push(`Missing baseline ref: ${String(baseline.ref)}`);
    }
  }
  if (errors.length > 0) {
    return [];
  }

  const replayRoot = await createReplayWorktree(
    repoCache,
    commit,
    workspaceRoot,
    `strict_${slugify(String(manifest.id ?? "case"))}_${stamp()}_${randomBytes(4).toString("hex")}`
  );
  const outcomes: ValidatorOutcome[] = [];
  try {
    const env = privateValidatorEnv(caseDir, replayRoot);
    for (const setupOutcome of runSetupCommands(manifest, replayRoot, env)) {
      if (setupOutcome.actual !== "pass") {
        errors.push(`Setup command failed: ${setupOutcome.id}\n${setupOutcome.stderr || setupOutcome.stdout}`);
        return outcomes;
      }
    }

    outcomes.push(
      ...(await runValidators({
        caseDir,
        manifest,
        replayRoot,
        env,
        expectedMode: "baseline",
        errors
      }))
    );
    return outcomes;
  } finally {
    await cleanupReplayWorktree(repoCache, replayRoot);
  }
}

export async function validateCaseBundle(
  caseDirInput: string,
  options: { strict?: boolean; workspaceRoot?: string } = {}
): Promise<ValidationResult> {
  const caseDir = absolutePath(caseDirInput);
  const errors: string[] = [];
  const warnings: string[] = [];
  const manifestPath = join(caseDir, "case.json");
  let manifest: JsonObject;
  try {
    manifest = await readJson(manifestPath);
  } catch (error) {
    return { ok: false, errors: [`Cannot read case.json: ${(error as Error).message}`], warnings };
  }

  validateManifestShape(manifest, errors);
  if (options.strict) {
    validateRequiredReplayEnv(manifest, errors);
  }
  await validateCasePaths(caseDir, manifest, Boolean(options.strict), errors);

  let validatorOutcomes: ValidatorOutcome[] | undefined;
  if (options.strict && errors.length === 0) {
    if (!options.workspaceRoot) {
      errors.push("Strict validation requires workspaceRoot.");
    } else {
      validatorOutcomes = await runStrictValidation(caseDir, manifest, absolutePath(options.workspaceRoot), errors);
    }
  }

  return { ok: errors.length === 0, errors, warnings, validatorOutcomes };
}

async function readTransaction(transactionPathInput: string): Promise<JsonObject> {
  const transactionPath = absolutePath(transactionPathInput);
  return await readJson(join(transactionPath, "transaction.json"));
}

export async function strictValidateTransaction(transactionPathInput: string): Promise<ValidationResult> {
  const transactionPath = absolutePath(transactionPathInput);
  const transaction = await readTransaction(transactionPath);
  const caseDir = String(transaction.caseDir ?? join(transactionPath, "case"));
  const workspaceRoot = String(transaction.workspaceRoot ?? "");
  const result = await validateCaseBundle(caseDir, { strict: true, workspaceRoot });
  if (result.ok) {
    transaction.strictValidatedAt = nowIso();
    transaction.lastValidation = result;
    await writeJson(join(transactionPath, "transaction.json"), transaction);
  }
  return result;
}

export async function finalizeTransaction(transactionPathInput: string): Promise<{ casePath: string; caseId: string }> {
  const transactionPath = absolutePath(transactionPathInput);
  const transaction = await readTransaction(transactionPath);
  const validation = transaction.strictValidatedAt ? ({ ok: true } as ValidationResult) : await strictValidateTransaction(transactionPath);
  if (!validation.ok) {
    throw new Error(`Cannot finalize: strict validation failed:\n${validation.errors.join("\n")}`);
  }
  const workspaceRoot = String(transaction.workspaceRoot);
  const caseDir = String(transaction.caseDir ?? join(transactionPath, "case"));
  const manifest = await readJson(join(caseDir, "case.json"));
  const caseId = String(manifest.id);
  const destination = join(workspaceRoot, "cases", caseId);
  if (await pathExists(destination)) {
    throw new Error(`Case already exists: ${destination}`);
  }
  await cp(caseDir, destination, { recursive: true, force: false });
  const copiedManifest = await readJson(join(destination, "case.json"));
  if (String(copiedManifest.id) !== caseId) {
    throw new Error("Finalize verification failed: copied manifest mismatch.");
  }
  await rm(transactionPath, { recursive: true, force: true });
  return { casePath: destination, caseId };
}
