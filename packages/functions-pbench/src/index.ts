import type { FunctionCommand } from "@ya-skills/core";
import { createCodexSessionSource } from "./adapters/codex.js";
import { createClaudeSessionSource } from "./adapters/claude.js";
import type { JsonObject, NormalizedSession, SessionSource } from "./adapters/types.js";
import { createPbenchReport, renderPbenchReportMarkdown } from "./reporting.js";
import { createReplay, validateReplayBaseline } from "./replay.js";
import type { ValidatorOutcome } from "./run-types.js";
export type { ValidatorOutcome } from "./run-types.js";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { stdin as input, stdout as output } from "node:process";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";

const MAX_PUBLIC_TEXT_FILE_BYTES = 64 * 1024;
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });
const VALIDATOR_AUTHORING_SENTINEL = "PBENCH_AUTHORING_REQUIRED";
const PUBLIC_REPLAY_MANIFEST_PATH = "public/replay.manifest.json";
const PUBLIC_CONTEXT_MANIFEST_PATH = "public/context.manifest.json";
const PUBLIC_KEY_OBSERVATIONS_PATH = "public/key-observations.md";
const PUBLIC_COMMAND_OBSERVATIONS_PATH = "public/command-observations.md";
const PBENCH_RUNNER_SKILL_NAME = "pbench-runner";
const PRIVATE_PATH_PLACEHOLDER = "<private-path>";
const SUBJECT_REPO_PLACEHOLDER = "<subject-repo>";

function indexById<T extends { id: string }>(items: T[]): Record<string, T> {
  if (items.length === 0) {
    throw new Error("Adapter registry cannot be empty.");
  }
  const entries = new Map<string, T>();
  for (const item of items) {
    if (!item.id || entries.has(item.id)) {
      throw new Error(`Adapter registry contains an empty or duplicate id: ${item.id}`);
    }
    entries.set(item.id, item);
  }
  return Object.fromEntries(entries);
}

const SESSION_SOURCES = indexById<SessionSource>([
  createCodexSessionSource(),
  createClaudeSessionSource()
]);
const REPLAY = createReplay({
  validateCaseBundle: (caseDir) => validateCaseBundle(caseDir, { strict: false })
});

type ReplayRequirements = {
  profile: "local" | "live-integration";
  network: "none" | "optional" | "required" | "unknown";
  requiredEnv: string[];
  notes: string[];
};

export type ValidationResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  validatorOutcomes?: ValidatorOutcome[];
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
  source?: string;
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
  authoringChecklistPath: string;
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

export function createPbenchCommands(options: PbenchCommandOptions = {}): FunctionCommand[] {
  return [
    {
      domain: "pbench",
      action: "capture",
      description: "Create a persistent pbench authoring transaction from a coding-agent session.",
      run: async (args) => {
        const parsed = parseArgs(args);
        const source = getString(parsed, "source") ?? "codex";
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
          source,
          yes,
          title: getString(parsed, "title"),
          home: options.home
        });
        const initialValidation = await validateAuthoringDraft(result.caseDir);
        return printJson({
          ...result,
          initialValidation,
          state: initialValidation.ok ? "ready-to-finalize" : "needs-authoring",
          nextAction: initialValidation.ok
            ? `yk pbench finalize --transaction ${result.transactionPath}`
            : `Read ${result.authoringChecklistPath}`,
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
        const manual = getBoolean(parsed, "manual");
        const requestedAgent = getString(parsed, "agent");
        if (manual && requestedAgent) {
          throw new Error("yk pbench run --manual and --agent cannot be used together.");
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
        const profile = normalizeRunProfile(getString(parsed, "profile"));
        if (manual) {
          return printJson(
            await REPLAY.startManualRun({
              caseDir,
              workspaceRoot,
              home: options.home,
              profile,
              contaminated: getBoolean(parsed, "contaminated")
            })
          );
        }
        return printJson(
          await REPLAY.runCase({
            caseDir,
            workspaceRoot,
            home: options.home,
            agent: requestedAgent ?? "codex",
            profile
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
          await REPLAY.startManualRun({
            caseDir,
            workspaceRoot,
            home: options.home,
            profile: normalizeRunProfile(getString(parsed, "profile")),
            contaminated: getBoolean(parsed, "contaminated")
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
        return printJson(await REPLAY.finishRun({ runId, home: options.home }));
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
        const report = await createPbenchReport({
          workspaceRoot,
          caseFilter: await resolveReportCaseFilter({
            caseInput: getString(parsed, "case"),
            cwd: process.cwd(),
            home: options.home
          }),
          profileFilter: getString(parsed, "profile") ? normalizeRunProfile(getString(parsed, "profile")) : undefined,
          includeUntrusted: getBoolean(parsed, "include-untrusted")
        });
        const format = getString(parsed, "format") ?? "markdown";
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
        const caseInput = getString(parsed, "case");
        if (caseInput) {
          const caseDir = await resolveCaseDirInput({
            caseInput,
            cwd: process.cwd(),
            home: options.home,
            workspace: getString(parsed, "workspace")
          });
          return printJson(await auditPbenchCase(caseDir));
        }
        const workspaceRoot = await resolveWorkspaceRoot({
          workspace: getString(parsed, "workspace"),
          cwd: process.cwd(),
          home: options.home
        });
        return printJson(await auditPbenchWorkspace(workspaceRoot));
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
  if (/(^|[\s"'`(=:[{])[\w-]+-session\.jsonl\b/.test(text)) {
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

async function auditPbenchWorkspace(workspaceRoot: string): Promise<JsonObject> {
  const casesRoot = join(workspaceRoot, "cases");
  if (!(await pathExists(casesRoot))) {
    return {
      schemaVersion: 1,
      workspaceRoot,
      ok: true,
      totals: { cases: 0, passed: 0, failed: 0, warnings: 0 },
      cases: []
    };
  }

  const entries = (await readdir(casesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  const cases: JsonObject[] = [];
  for (const entry of entries) {
    const audit = await auditPbenchCase(join(casesRoot, entry.name));
    cases.push({ ...audit, caseId: audit.caseId || entry.name });
  }
  const failed = cases.filter((audit) => audit.ok !== true).length;
  const warnings = cases.reduce((total, audit) => total + (Array.isArray(audit.warnings) ? audit.warnings.length : 0), 0);
  return {
    schemaVersion: 1,
    workspaceRoot,
    ok: failed === 0,
    totals: {
      cases: cases.length,
      passed: cases.length - failed,
      failed,
      warnings
    },
    cases
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

type CaptureSubject = {
  sourceRepoRoot: string;
  sourceCwd: string;
  warnings: string[];
};

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

export async function captureSession(options: CaptureOptions = {}): Promise<CaptureResult> {
  const cwd = absolutePath(options.cwd ?? process.cwd());
  const home = options.home ?? homedir();
  const workspaceRoot = options.workspaceRoot
    ? absolutePath(options.workspaceRoot, cwd, home)
    : await resolveWorkspaceRoot({ cwd, home, createDefault: options.yes });
  await assertWorkspace(workspaceRoot);
  const sourceId = options.source ?? "codex";
  const source = SESSION_SOURCES[sourceId];
  if (!source) {
    throw new Error(`Unknown capture source "${sourceId}". Known sources: ${Object.keys(SESSION_SOURCES).join(", ")}.`);
  }
  const inputPath = options.input
    ? absolutePath(options.input, cwd, home)
    : await source.locate({ cwd, sessionId: options.sessionId, home });
  const rawText = await readFile(inputPath, "utf8");
  const extracted = source.extract(rawText);
  const meta = extracted.meta;
  const sourceKind = source.sourceKind;
  const rawFilename = `${source.id}-session.jsonl`;
  const subject = resolveCaptureSubject(cwd, meta, home);
  const sourceRepoRoot = subject.sourceRepoRoot;
  const rawTitle = options.title ?? selectedTaskTitle(extracted) ?? `${sourceId} session capture`;
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
  const authoring = buildAuthoringArtifacts(rawTitle, extracted, sourceRepoRoot);
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
      tags: [sourceId, "capture", "git-baseline"],
      createdAt,
      source: { kind: sourceKind, sessionId: String(meta.id ?? options.sessionId ?? basename(inputPath)) }
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
      authoringChecklist: "private/authoring-checklist.md",
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
        cwd: authoring.validatorCwd,
        timeoutSeconds: 120,
        baselineExpected: "fail"
      }
    ],
    replayRequirements
  };
  const sanitizePublicText = makePublicReplaySanitizer({
    sourceRepoRoot,
    captureCwd: subject.sourceCwd,
    caseDir,
    inputPath
  });

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
  await writeFile(join(caseDir, "private", "artifacts", "raw", rawFilename), rawText);
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
  const replayContext = await writeReplayContext({
    caseDir,
    caseId,
    title: rawTitle,
    createdAt,
    sourceRepoRoot,
    captureCwd: subject.sourceCwd,
    baselineCommit,
    setupCommands: manifest.setupCommands,
    extracted,
    sourceKind,
    replayRequirements,
    sanitizePublicText
  });
  await writeJson(join(caseDir, "case.json"), { ...manifest, replayStart: replayContext.replayStart });
  const authoringChecklistPath = join(caseDir, "private", "authoring-checklist.md");
  await writeAuthoringChecklist(authoringChecklistPath, {
    authoring,
    setupCommands: manifest.setupCommands,
    replayWarnings: replayContext.warnings,
    replayStart: replayContext.replayStart
  });
  await writeJson(join(transactionPath, "transaction.json"), {
    schemaVersion: 1,
    transactionPath,
    workspaceRoot,
    caseDir,
    caseId,
    sourceRoot: sourceRepoRoot,
    source: { kind: sourceKind, inputPath },
    createdAt,
    strictValidatedAt: null
  });

  return { transactionPath, caseDir, caseId, workspaceRoot, authoringChecklistPath, warnings: subject.warnings };
}

export const captureCodexSession = captureSession;

async function writeAuthoringChecklist(
  path: string,
  options: {
    authoring: GeneratedAuthoringArtifacts;
    setupCommands: JsonObject[];
    replayWarnings: string[];
    replayStart: ReplayStart;
  }
): Promise<void> {
  const generated = options.authoring.validatorScript.includes(VALIDATOR_AUTHORING_SENTINEL)
    ? "needs manual authoring"
    : `generated command validator (cwd: ${options.authoring.validatorCwd})`;
  const setup =
    options.setupCommands.length > 0
      ? options.setupCommands.map((command) => `${String(command.command)} (cwd: ${String(command.cwd ?? ".")})`).join(", ")
      : "none detected";
  const replayWarnings =
    options.replayWarnings.length > 0 ? options.replayWarnings.map((warning) => `  - ${warning}`).join("\n") : "  - none";
  const replayStart =
    options.replayStart.status === "unresolved"
      ? [
          "- Replay start needs authoring:",
          "  - baseline: set case.json replayStart.status to baseline and keep current dirty candidates private.",
          "  - curated: copy selected candidates into public replay files, update both public manifests, and set replayStart.status to curated."
        ]
      : [`- Replay start: ${options.replayStart.status}`];
  await writeFile(
    path,
    [
      "# Authoring Checklist",
      "",
      "- Prompt present: " + (options.authoring.hasPrompt ? "yes" : "no"),
      "- Failure evidence present: " + (options.authoring.hasFailureEvidence ? "yes" : "no"),
      "- Replayable verification found: " + (!options.authoring.validatorScript.includes(VALIDATOR_AUTHORING_SENTINEL) ? "yes" : "no"),
      "- Generated validator: " + generated,
      "- Setup commands: " + setup,
      ...replayStart,
      "- Public replay warnings:",
      replayWarnings,
      ""
    ].join("\n")
  );
}

function selectedTaskTitle(extracted: NormalizedSession): string | null {
  const first = extracted.userMessages[0]?.split(/\r?\n/)[0]?.trim();
  return first ? first.slice(0, 80) : null;
}

type GeneratedAuthoringArtifacts = {
  failure: string;
  success: string;
  verification: string;
  validatorCwd: string;
  hasFailureEvidence: boolean;
  hasPrompt: boolean;
  validatorScript: string;
};

type VerificationCommand = {
  command: string;
  cwd: string;
  replayCwd: string | null;
  unsafeReason?: string;
  stderr: string;
  stdout: string;
};

function buildAuthoringArtifacts(title: string, extracted: NormalizedSession, sourceRepoRoot: string): GeneratedAuthoringArtifacts {
  const prompt = extracted.userMessages[0]?.trim() ?? "";
  const corrections = extracted.userMessages.slice(1).map(evidenceLine).filter(Boolean);
  const errors = extracted.errorRecords.map(errorEvidenceLine).filter(Boolean);
  const failedVerification = findFailedVerificationCommand(extracted, sourceRepoRoot);
  const validatorCwd = failedVerification?.replayCwd ?? ".";

  return {
    failure: renderFailureDocument(corrections, errors),
    success: renderSuccessDocument(title, prompt, corrections),
    verification: renderVerificationDocument(failedVerification),
    validatorCwd,
    hasFailureEvidence: corrections.length > 0 || errors.length > 0,
    hasPrompt: prompt.length > 0,
    validatorScript: failedVerification?.replayCwd
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
    if (command.replayCwd) {
      lines.push(
        "The completion validator reruns the failed verification command captured in the original session:",
        "",
        `- command: \`${command.command}\``,
        `- cwd: ${command.replayCwd}`,
        "- pass condition: exit code 0",
        ""
      );
    } else {
      lines.push(
        "The captured verification cwd cannot be replayed safely, so the completion validator must be implemented manually.",
        "",
        `- command: \`${command.command}\``,
        `- captured cwd: ${command.cwd}`,
        `- reason: ${command.unsafeReason ?? "unsafe cwd"}`,
        ""
      );
    }
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

function realPathOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function replayCwdFromCapturedCwd(cwd: string, sourceRepoRoot: string): { replayCwd: string | null; unsafeReason?: string } {
  if (!cwd || cwd === "unknown") {
    return { replayCwd: "." };
  }
  if (isAbsolute(cwd)) {
    const resolvedRepo = realPathOrResolved(sourceRepoRoot);
    const resolvedCwd = realPathOrResolved(cwd);
    const relativeCwd = relative(resolvedRepo, resolvedCwd).replace(/\\/g, "/");
    if (relativeCwd === "") {
      return { replayCwd: "." };
    }
    if (!relativeCwd.startsWith("../") && relativeCwd !== ".." && !isAbsolute(relativeCwd)) {
      return { replayCwd: relativeCwd };
    }
    return { replayCwd: null, unsafeReason: "cwd is outside the captured subject repository" };
  }
  const safe = safeRelativePath(cwd);
  if (!safe) {
    return { replayCwd: null, unsafeReason: "cwd is not a safe repo-relative path" };
  }
  return { replayCwd: safe };
}

function findFailedVerificationCommand(extracted: NormalizedSession, sourceRepoRoot: string): VerificationCommand | null {
  const candidates: VerificationCommand[] = [];
  for (const record of extracted.errorRecords) {
    const command = commandText(record).trim();
    if (!isReplayableVerificationCommand(command)) {
      continue;
    }
    const args = asObject(record.arguments) ?? {};
    const cwd = String(args.cwd ?? args.workdir ?? record.cwd ?? record.workdir ?? ".");
    const replayCwd = replayCwdFromCapturedCwd(cwd, sourceRepoRoot);
    candidates.push({
      command,
      cwd,
      ...replayCwd,
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
    "console.error('Read private/failure.md, private/success.md, private/verification.md, and the raw session transcript under private/artifacts/raw/.');",
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
  extracted: NormalizedSession;
  sourceKind: string;
  replayRequirements: ReplayRequirements;
  sanitizePublicText: (text: string) => string;
};

type PublicContextFile = {
  source: string;
  publicPath: string;
  kind: "untracked";
};

type ReplayStart = {
  status: "clean" | "unresolved" | "baseline" | "curated";
  candidateTrackedPatch?: "private/artifacts/extracted/starting.patch";
  candidateUntrackedManifest?: "private/artifacts/extracted/untracked.manifest.json";
};

async function writeReplayContext(options: ReplayContextOptions): Promise<{ warnings: string[]; replayStart: ReplayStart }> {
  const warnings: string[] = [];
  const agentInstructionsPath = await writeAgentInstructions(
    options.caseDir,
    options.sourceRepoRoot,
    options.captureCwd,
    options.sanitizePublicText
  );
  const keyObservationsPath = await writeKeyObservations(options.caseDir, options.extracted, options.sanitizePublicText);
  const commandObservationsPath = await writeCommandObservations(options.caseDir, options.extracted, options.sanitizePublicText);
  const replayStart = await captureReplayStartCandidates(options.caseDir, options.sourceRepoRoot, warnings);
  const contextFiles: PublicContextFile[] = [];
  await writeFailureDraft(options.caseDir, options.extracted);

  const replayFiles = {
    replay: "public/replay.md",
    replayManifest: PUBLIC_REPLAY_MANIFEST_PATH,
    contextManifest: PUBLIC_CONTEXT_MANIFEST_PATH,
    agentInstructions: agentInstructionsPath,
    keyObservations: keyObservationsPath,
    commandObservations: commandObservationsPath,
    startingPatch: null
  };
  const contextManifest = {
    schemaVersion: 1,
    caseId: options.caseId,
    title: options.title,
    createdAt: options.createdAt,
    source: {
      kind: options.sourceKind,
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
  return { warnings, replayStart };
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
  extracted: NormalizedSession,
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
  extracted: NormalizedSession,
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

async function captureReplayStartCandidates(
  caseDir: string,
  repoRoot: string,
  warnings: string[]
): Promise<ReplayStart> {
  const replayStart: ReplayStart = { status: "clean" };
  const trackedPatch = execGitRaw(repoRoot, ["diff", "--binary", "HEAD", "--", "."]);
  if (trackedPatch) {
    const candidatePath = "private/artifacts/extracted/starting.patch" as const;
    await writeFile(join(caseDir, candidatePath), trackedPatch);
    replayStart.status = "unresolved";
    replayStart.candidateTrackedPatch = candidatePath;
  }

  const files = execGit(repoRoot, ["ls-files", "--others", "--exclude-standard"])
    .split(/\r?\n/)
    .map((file) => file.trim())
    .filter(Boolean);
  if (files.length > 0) {
    replayStart.status = "unresolved";
    replayStart.candidateUntrackedManifest = "private/artifacts/extracted/untracked.manifest.json";
    const candidates: JsonObject[] = [];
    for (const file of files) {
      const safe = safeRelativePath(file);
      if (!safe || safe.startsWith(".git/")) {
        warnings.push(`Skipped unsafe untracked path: ${file}`);
        candidates.push({ source: file, status: "skipped", reason: "unsafe path" });
        continue;
      }
      const sourcePath = join(repoRoot, safe);
      const info = await lstat(sourcePath).catch(() => null);
      if (info?.isSymbolicLink()) {
        warnings.push(`Skipped symbolic-link untracked file: ${safe}`);
        candidates.push({ source: safe, status: "skipped", reason: "symbolic link" });
        continue;
      }
      if (!info?.isFile()) {
        candidates.push({ source: safe, status: "skipped", reason: "not a file" });
        continue;
      }
      if (info.size > MAX_PUBLIC_TEXT_FILE_BYTES) {
        warnings.push(`Skipped large untracked file: ${safe}`);
        candidates.push({ source: safe, status: "skipped", reason: "large file", sizeBytes: info.size });
        continue;
      }
      const bytes = await readFile(sourcePath);
      if (!isUtf8Text(bytes)) {
        warnings.push(`Skipped binary untracked file: ${safe}`);
        candidates.push({ source: safe, status: "skipped", reason: "binary file", sizeBytes: info.size });
        continue;
      }
      const candidatePath = `private/artifacts/extracted/untracked/${safe.replace(/\\/g, "/")}`;
      await mkdir(dirname(join(caseDir, candidatePath)), { recursive: true });
      await writeFile(join(caseDir, candidatePath), bytes);
      candidates.push({ source: safe.replace(/\\/g, "/"), status: "copied", candidatePath, sizeBytes: info.size });
    }
    await writeJson(join(caseDir, replayStart.candidateUntrackedManifest), { schemaVersion: 1, files: candidates });
  }

  return replayStart;
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

async function writeFailureDraft(caseDir: string, extracted: NormalizedSession): Promise<void> {
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

function execGitRaw(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
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
    if (path === "private/verification.md" && content.includes("The captured verification cwd cannot be replayed safely")) {
      warnings.push("private/verification.md has unsafe verification cwd; implement validator manually");
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
  const replayStart = asObject(manifest.replayStart);
  const replayStartStatus = replayStart?.status;
  if (!(["clean", "unresolved", "baseline", "curated"] as unknown[]).includes(replayStartStatus)) {
    errors.push("/replayStart.status must be clean, unresolved, baseline, or curated");
  } else if (replayStartStatus === "unresolved") {
    errors.push("START_STATE_UNRESOLVED: choose baseline or curate replay-start files");
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
      validatorOutcomes = await validateReplayBaseline({
        caseDir,
        manifest,
        workspaceRoot: absolutePath(options.workspaceRoot),
        errors
      });
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
  const validation = await strictValidateTransaction(transactionPath);
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
