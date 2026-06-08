import type { FunctionCommand } from "@ya-skills/core";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { stdin as input, stdout as output } from "node:process";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";

type JsonObject = Record<string, unknown>;

const MAX_PUBLIC_TEXT_FILE_BYTES = 64 * 1024;
const MAX_PUBLIC_PATCH_BYTES = 512 * 1024;
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });
const VALIDATOR_AUTHORING_SENTINEL = "PBENCH_AUTHORING_REQUIRED";

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

function pbenchCaptureRoot(home = homedir()): string {
  return join(home, ".ya-skills", "pbench");
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
      contextManifest: "public/context.manifest.json",
      agentInstructions: "public/agent-instructions.md",
      commandObservations: "public/command-observations.md",
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
    ]
  };
  const authoring = buildAuthoringArtifacts(rawTitle, extracted);

  await writeJson(join(caseDir, "case.json"), manifest);
  await writeFile(
    join(caseDir, "README.md"),
    `# ${rawTitle}\n\nGenerated by yk pbench capture. Review generated authoring docs, finish the completion validator if needed, then run strict validation.\n`
  );
  await writeFile(join(caseDir, "public", "prompt.md"), `${extracted.userMessages[0] ?? ""}\n`);
  await writeFile(
    join(caseDir, "public", "context.md"),
    [
      `Subject repo at capture: ${sourceRepoRoot}`,
      `Session cwd: ${String(meta.cwd ?? "unknown")}`,
      `Session id: ${String(meta.id ?? options.sessionId ?? basename(inputPath))}`,
      `Baseline commit: ${baselineCommit}`,
      `Branch at capture: ${String(branchAtCapture ?? "unknown")}`,
      ""
    ].join("\n")
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
    extracted
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
};

type PublicContextFile = {
  source: string;
  publicPath: string;
  kind: "untracked";
};

async function writeReplayContext(options: ReplayContextOptions): Promise<void> {
  const warnings: string[] = [];
  const agentInstructionsPath = await writeAgentInstructions(options.caseDir, options.sourceRepoRoot, options.captureCwd);
  const commandObservationsPath = await writeCommandObservations(options.caseDir, options.extracted);
  const startingPatchPath = await writeStartingPatch(options.caseDir, options.sourceRepoRoot, warnings);
  const contextFiles = await writeUntrackedContextFiles(options.caseDir, options.sourceRepoRoot, warnings);
  await writeFailureDraft(options.caseDir, options.extracted);

  const replayFiles = {
    replay: "public/replay.md",
    contextManifest: "public/context.manifest.json",
    agentInstructions: agentInstructionsPath,
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
      cwd: options.extracted.meta.cwd ?? null,
      model: options.extracted.meta.model ?? null
    },
    baseline: {
      repoRoot: options.sourceRepoRoot,
      commit: options.baselineCommit
    },
    packageManager: inferPackageManager(options.setupCommands),
    setupCommands: options.setupCommands,
    replayFiles,
    contextFiles,
    warnings
  };

  await writeJson(join(options.caseDir, "public", "context.manifest.json"), contextManifest);
  await writeFile(join(options.caseDir, "public", "replay.md"), renderReplayMarkdown(options, replayFiles, contextFiles, warnings));
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
    `- Context manifest: ${String(replayFiles.contextManifest)}`,
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
    "## Command Observations",
    "",
    `Read \`${String(replayFiles.commandObservations)}\` for bounded command/tool observations captured from the original session.`,
    "",
    "## Context Files",
    "",
    fileLines,
    "",
    "## Warnings",
    "",
    warningLines,
    "",
    "Do not inspect private evaluator files during replay."
  ].join("\n");
}

async function writeAgentInstructions(caseDir: string, repoRoot: string, captureCwd: string): Promise<string> {
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
  await writeFile(join(caseDir, publicPath), lines.join("\n"));
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

async function writeCommandObservations(caseDir: string, extracted: ExtractedCodexSession): Promise<string> {
  const lines = ["# Command Observations", ""];
  const commandRecords = extracted.toolCalls.filter((record) => commandText(record));
  if (commandRecords.length === 0) {
    lines.push("No command-like tool calls captured.", "");
  }
  for (const [index, record] of commandRecords.entries()) {
    const args = asObject(record.arguments) ?? {};
    lines.push(`## ${index + 1}. ${commandText(record)}`, "");
    lines.push(`- cwd: ${String(args.cwd ?? args.workdir ?? record.cwd ?? record.workdir ?? "unknown")}`);
    lines.push(`- status: ${String(record.status ?? record.outcome ?? "unknown")}`);
    lines.push(`- exitCode: ${String(record.exit_code ?? record.exitCode ?? "unknown")}`);
    const stdoutText = excerpt(String(record.stdout ?? ""));
    const stderrText = excerpt(String(record.stderr ?? ""));
    if (stdoutText) lines.push("", "stdout:", fenced(stdoutText));
    if (stderrText) lines.push("", "stderr:", fenced(stderrText));
    lines.push("");
  }
  const publicPath = "public/command-observations.md";
  await writeFile(join(caseDir, publicPath), lines.join("\n"));
  return publicPath;
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
  const patch = execGitOptional(repoRoot, ["diff", "--binary", "HEAD", "--", "."]);
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

function relativePathFrom(root: string, path: string): string {
  return relative(root, path).replace(/\\/g, "/");
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
