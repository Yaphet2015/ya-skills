import type { JsonObject, NormalizedSession, SessionSource } from "./adapters/types.js";
import {
  absolutePath,
  assertWorkspace,
  initWorkspace,
  linkProject,
  resolveCaseDirInput,
  resolveReportCaseFilter,
  resolveWorkspaceRoot
} from "./workspace.js";
import {
  detectSetupCommands,
  getBranch,
  getHeadCommit,
  getOrigin,
  resolveGitRoot,
  syncRepoCache
} from "./git.js";
import {
  captureReplayStartCandidates,
  writeFailureDraft,
  writeObservationDocument,
  PUBLIC_COMMAND_OBSERVATIONS_PATH,
  PUBLIC_KEY_OBSERVATIONS_PATH
} from "./observations.js";
import {
  buildAuthoringArtifacts,
  findAuthoringWarnings,
  selectedTaskTitle,
  VALIDATOR_AUTHORING_SENTINEL,
  writeAuthoringChecklist
} from "./documents.js";
import { validateReplayBaseline } from "./evaluation.js";
import {
  assertPublicReplayHasNoPrivateReferences,
  buildPublicCaseManifest,
  requiredReplayEnv,
  type ReplayRequirements
} from "./replay-boundary.js";
import {
  asArray,
  asObject,
  isMissingPathError,
  nowIso,
  pathExists,
  relativePathFrom,
  readJson,
  safeRelativePath,
  slugify,
  stamp,
  writeJson
} from "./shared.js";
import type { ValidatorOutcome } from "./run-types.js";
export { slugify } from "./shared.js";
export type { ValidatorOutcome } from "./run-types.js";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { stdin as input, stdout as output } from "node:process";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";

const PUBLIC_REPLAY_MANIFEST_PATH = "public/replay.manifest.json";
const PUBLIC_CONTEXT_MANIFEST_PATH = "public/context.manifest.json";
const PRIVATE_PATH_PLACEHOLDER = "<private-path>";
const SUBJECT_REPO_PLACEHOLDER = "<subject-repo>";

export {
  absolutePath,
  initWorkspace,
  linkProject,
  resolveCaseDirInput,
  resolveReportCaseFilter,
  resolveWorkspaceRoot,
  resolveGitRoot,
  findAuthoringWarnings
};
export type { GeneratedAuthoringArtifacts } from "./documents.js";
export type { WorkspaceInfo } from "./workspace.js";

export type ValidationResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  validatorOutcomes?: ValidatorOutcome[];
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



function pbenchCaptureRoot(home = homedir()): string {
  return join(home, ".ya-skills", "pbench");
}

function defaultReplayRequirements(): ReplayRequirements {
  return { profile: "local", network: "unknown", requiredEnv: [], notes: [] };
}

export function makeCaseId(title: string, now = new Date()): string {
  return `case_${slugify(title)}_${stamp(now)}`;
}

export async function exportReplayCapsule(options: {
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

async function captureWithSources(
  options: CaptureOptions,
  sessionSources: ReadonlyMap<string, SessionSource>
): Promise<CaptureResult> {
  const cwd = absolutePath(options.cwd ?? process.cwd());
  const home = options.home ?? homedir();
  const workspaceRoot = options.workspaceRoot
    ? absolutePath(options.workspaceRoot, cwd, home)
    : await resolveWorkspaceRoot({ cwd, home, createDefault: options.yes });
  await assertWorkspace(workspaceRoot);
  const sourceId = options.source ?? "codex";
  const source = sessionSources.get(sourceId);
  if (!source) {
    throw new Error(`Unknown capture source "${sourceId}". Known sources: ${[...sessionSources.keys()].join(", ")}.`);
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
  const keyObservationsPath = await writeObservationDocument(
    options.caseDir,
    options.extracted,
    options.sanitizePublicText,
    "key"
  );
  const commandObservationsPath = await writeObservationDocument(
    options.caseDir,
    options.extracted,
    options.sanitizePublicText,
    "all"
  );
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

export async function validateAuthoringDraft(caseDir: string): Promise<ValidationResult> {
  const result = await validateCaseBundle(caseDir, { strict: false });
  const warnings = [...result.warnings, ...(await findAuthoringWarnings(caseDir))];
  return {
    ...result,
    ok: result.ok && warnings.length === 0,
    warnings
  };
}


function validatePathField(errors: string[], field: string, value: unknown): string | null {
  const safe = safeRelativePath(value);
  if (!safe) {
    errors.push(`Unsafe or invalid case-local path in ${field}: ${String(value)}`);
  }
  return safe;
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

export type AuthoringDependencies = {
  sessionSources: ReadonlyMap<string, SessionSource>;
};

export function createAuthoring(dependencies: AuthoringDependencies) {
  return {
    captureSession: (options: CaptureOptions = {}) => captureWithSources(options, dependencies.sessionSources),
    validateCaseBundle,
    strictValidateTransaction,
    finalizeTransaction,
    exportReplayCapsule
  };
}
