import type { FunctionCommand } from "@ya-skills/core";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { stdin as input, stdout as output } from "node:process";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";

type JsonObject = Record<string, unknown>;

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

export function createPbenchCommands(): FunctionCommand[] {
  return [
    {
      domain: "pbench",
      action: "capture",
      description: "Create a temporary pbench authoring transaction from a Codex session.",
      run: async (args) => {
        const parsed = parseArgs(args);
        const source = getString(parsed, "source");
        if (source !== "codex") {
          throw new Error("yk pbench capture supports only --source codex");
        }
        const workspace = getString(parsed, "workspace");
        const yes = getBoolean(parsed, "yes");
        const workspaceRoot = workspace
          ? await resolveWorkspaceRoot({ workspace, cwd: process.cwd(), createDefault: yes })
          : await resolveWorkspaceRoot({ cwd: process.cwd(), createDefault: yes });
        const result = await captureCodexSession({
          cwd: process.cwd(),
          workspaceRoot,
          input: getString(parsed, "input"),
          sessionId: getString(parsed, "session-id"),
          yes,
          title: getString(parsed, "title")
        });
        return printJson({
          ...result,
          initialValidation: await validateAuthoringDraft(result.caseDir),
          next: [
            `Fill ${result.caseDir}`,
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

function extractCodexSession(records: JsonObject[]): ExtractedCodexSession {
  const meta = records.find((record) => record.type === "session_meta" || record.type === "session") ?? {};
  const userMessages: string[] = [];
  const assistantMessages: string[] = [];
  const toolCalls: JsonObject[] = [];
  const errorRecords: JsonObject[] = [];
  const approvalSandboxRecords: JsonObject[] = [];
  const touched = new Set<string>();
  const timeline: string[] = [];

  for (const [index, record] of records.entries()) {
    const message = record.message && typeof record.message === "object" ? (record.message as JsonObject) : undefined;
    const item = record.item && typeof record.item === "object" ? (record.item as JsonObject) : undefined;
    const role = record.role ?? message?.role;
    const type = String(record.type ?? "event");
    const content = valueToText(record.content ?? message?.content ?? item?.content);
    if (role === "user" && content) {
      userMessages.push(content);
    }
    if (role === "assistant" && content) {
      assistantMessages.push(content);
    }
    if (type.includes("tool") || type.includes("call") || record.name || record.arguments) {
      toolCalls.push(record);
      const serialized = JSON.stringify(record);
      for (const match of serialized.matchAll(/(?:path|file|cwd|workdir)"?\s*[:=]\s*"([^"\n]+)"/g)) {
        touched.add(match[1]);
      }
    }
    if (isErrorRecord(record)) {
      errorRecords.push(record);
    }
    if (isApprovalSandboxRecord(record)) {
      approvalSandboxRecords.push(record);
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
  if (!(await pathExists(indexPath))) {
    throw new Error(`Codex session index not found: ${indexPath}`);
  }
  const currentRepo = resolveGitRoot(options.cwd);
  const entries = parseJsonlLines(await readFile(indexPath, "utf8"));
  const candidates: { path: string; updatedAt: number }[] = [];

  for (const entry of entries) {
    const candidatePath = String(entry.path ?? entry.session_path ?? entry.file ?? "");
    if (!candidatePath) {
      continue;
    }
    if (options.sessionId && !JSON.stringify(entry).includes(options.sessionId)) {
      continue;
    }
    try {
      const expandedPath = expandHome(candidatePath, options.home);
      const records = parseJsonlLines(await readFile(expandedPath, "utf8"));
      const extracted = extractCodexSession(records);
      const sessionCwd = String(extracted.meta.cwd ?? entry.cwd ?? "");
      if (options.sessionId || (sessionCwd && resolveGitRoot(sessionCwd) === currentRepo)) {
        const time = Date.parse(
          String(entry.updated_at ?? entry.timestamp ?? extracted.meta.updated_at ?? extracted.meta.timestamp ?? 0)
        );
        candidates.push({ path: expandedPath, updatedAt: Number.isFinite(time) ? time : 0 });
      }
    } catch {
      continue;
    }
  }

  candidates.sort((a, b) => b.updatedAt - a.updatedAt);
  if (!candidates[0]) {
    throw new Error("No matching Codex session found for current Git repository. Use --input <jsonl>.");
  }
  return candidates[0].path;
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
  const sourceRepoRoot = resolveGitRoot(cwd);
  const inputPath = options.input ? absolutePath(options.input, cwd, home) : await findSessionFromIndex({ cwd, sessionId: options.sessionId, home });
  const rawText = await readFile(inputPath, "utf8");
  const records = parseJsonlLines(rawText);
  const extracted = extractCodexSession(records);
  const meta = extracted.meta;
  const rawTitle = options.title ?? extracted.userMessages[0]?.split(/\r?\n/)[0]?.slice(0, 80) ?? "codex session capture";
  const caseId = makeCaseId(rawTitle, options.now);
  const slug = caseId.match(/^case_(.*)_\d{8}T\d{6}Z$/)?.[1] ?? slugify(rawTitle);
  const gitMeta = meta.git && typeof meta.git === "object" ? (meta.git as JsonObject) : undefined;
  const baselineCommit = typeof gitMeta?.commit_hash === "string" ? gitMeta.commit_hash : getHeadCommit(sourceRepoRoot);
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
  const transactionRoot = join(tmpdir(), "personal-bench");
  await mkdir(transactionRoot, { recursive: true });
  const transactionPath = await mkdtemp(join(transactionRoot, `tx_${slug}_${stamp(options.now)}_`));
  const caseDir = join(transactionPath, "case");
  await ensureCaseSkeleton(caseDir);
  await mkdir(join(transactionPath, "replay"), { recursive: true });

  const createdAt = nowIso(options.now);
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
      failure: "private/failure.md",
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
        baseline: { commit: baselineCommit, ref, branchAtCapture: getBranch(sourceRepoRoot) }
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
    ]
  };

  await writeJson(join(caseDir, "case.json"), manifest);
  await writeFile(
    join(caseDir, "README.md"),
    `# ${rawTitle}\n\nGenerated by yk pbench capture. Fill public/private docs, write the completion validator, then run strict validation.\n`
  );
  await writeFile(join(caseDir, "public", "prompt.md"), `${extracted.userMessages[0] ?? ""}\n`);
  await writeFile(join(caseDir, "public", "context.md"), `Subject repo at capture: ${sourceRepoRoot}\nBaseline commit: ${baselineCommit}\n`);
  await writeFile(join(caseDir, "public", "environment.md"), `Captured at: ${createdAt}\nModel: ${String(meta.model ?? "unknown")}\n`);
  await writeFile(join(caseDir, "private", "failure.md"), "TODO: Describe the task/session-level outcome mismatch.\n");
  await writeFile(join(caseDir, "private", "success.md"), "TODO: Define observable completion criteria.\n");
  await writeFile(join(caseDir, "private", "verification.md"), "TODO: Explain how the validator checks completion.\n");
  await writeFile(
    join(caseDir, "private", "validators", "check-completion.mjs"),
    "console.error('TODO: implement completion validator');\nprocess.exit(2);\n"
  );
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

  return { transactionPath, caseDir, caseId, workspaceRoot };
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
    }
    if (validator.cwd !== undefined) {
      validatePathField(errors, `validators[${index}].cwd`, validator.cwd);
    }
  }
}

function repoCacheForSubject(workspaceRoot: string, subject: JsonObject): string {
  return join(workspaceRoot, "repos", `${String(subject.repoId)}.git`);
}

function createReplayWorktree(repoCache: string, commit: string): string {
  const replayRoot = execFileSync("mktemp", ["-d", join(tmpdir(), "personal-bench-replay-XXXXXX")], {
    encoding: "utf8"
  }).trim();
  execGitDir(repoCache, ["worktree", "add", "--detach", replayRoot, commit]);
  return replayRoot;
}

async function cleanupReplayWorktree(repoCache: string, replayRoot: string): Promise<void> {
  try {
    execGitDir(repoCache, ["worktree", "remove", "--force", replayRoot]);
  } catch {
    // The tmp directory removal below handles partially-created worktrees.
  }
  await rm(replayRoot, { recursive: true, force: true });
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

  const replayRoot = createReplayWorktree(repoCache, commit);
  const outcomes: ValidatorOutcome[] = [];
  try {
    const env = {
      ...process.env,
      PB_CASE_DIR: caseDir,
      PB_PUBLIC_DIR: join(caseDir, "public"),
      PB_PRIVATE_DIR: join(caseDir, "private"),
      PB_REPLAY_DIR: replayRoot
    };

    for (const setup of asArray(manifest.setupCommands)) {
      const command = String(setup.command ?? "");
      if (!command) {
        continue;
      }
      const cwd = join(replayRoot, safeRelativePath(setup.cwd ?? ".") ?? ".");
      const setupOutcome = runShell(command, cwd, Number(setup.timeoutSeconds ?? 300), env);
      if (setupOutcome.actual !== "pass") {
        errors.push(`Setup command failed: ${command}\n${setupOutcome.stderr || setupOutcome.stdout}`);
        return outcomes;
      }
    }

    const validators = asArray(manifest.validators);
    if (!validators.some((validator) => validator.purpose === "completion")) {
      errors.push("At least one completion validator is required.");
    }
    for (const validator of validators) {
      const expected = validator.baselineExpected === "pass" ? "pass" : "fail";
      let outcome: ValidatorOutcome;
      if (validator.type === "command") {
        const command = String(validator.command ?? "");
        const cwd = join(replayRoot, safeRelativePath(validator.cwd ?? ".") ?? ".");
        outcome = runShell(command, cwd, Number(validator.timeoutSeconds ?? 120), env);
        outcome.id = String(validator.id ?? command);
      } else {
        const scriptPath = join(caseDir, String(validator.path));
        await chmod(scriptPath, 0o755).catch(() => undefined);
        const cwd = join(replayRoot, safeRelativePath(validator.cwd ?? ".") ?? ".");
        const result = spawnSync("node", [scriptPath], {
          cwd,
          encoding: "utf8",
          timeout: Number(validator.timeoutSeconds ?? 120) * 1000,
          env
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
        errors.push(`Validator ${outcome.id} baseline outcome ${outcome.actual}, expected ${expected}.\n${outcome.stderr || outcome.stdout}`);
      }
    }
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
