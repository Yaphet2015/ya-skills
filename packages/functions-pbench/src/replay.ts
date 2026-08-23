import { detectSkillTargets } from "@ya-skills/core";
import type { AgentRunner, JsonObject } from "./adapters/types.js";
import {
  cleanupReplayWorktree,
  createReplayWorktree,
  privateValidatorEnv,
  runSetupCommands,
  runValidators
} from "./evaluation.js";
import {
  assertPublicReplayHasNoPrivateReferences,
  buildPublicCaseManifest,
  requiredReplayEnv,
  type AgentVisibleSurface
} from "./replay-boundary.js";
import {
  asArray,
  asObject,
  decodeUtf8Text,
  isMissingPathError,
  isUtf8Text,
  normalizeRunProfile,
  nowIso,
  pathExists,
  readJson,
  safeRelativePath,
  slugify,
  stamp,
  writeJson
} from "./shared.js";
import type { PbenchIntegrity, PbenchRunStatus, ValidatorOutcome } from "./run-types.js";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { arch, homedir, platform, release } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

const MAX_PUBLIC_TEXT_FILE_BYTES = 64 * 1024;
const PUBLIC_REPLAY_MANIFEST_PATH = "public/replay.manifest.json";
const PBENCH_RUNNER_SKILL_NAME = "pbench-runner";

type PbenchIsolation = "none" | "workspace-write";
type RunState = JsonObject & {
  schemaVersion: 1; runId: string; caseId: string; caseDir: string; workspaceRoot: string;
  artifactDir: string; worktree: string; repoCache: string; agentMode: string; profile: string;
  status: PbenchRunStatus; terminal: boolean; manualIntervention: boolean; isolation: PbenchIsolation;
  integrity: PbenchIntegrity; validatorExecuted: boolean; agentVersion: string | null; attemptNumber: number;
  priorRunIds: string[]; contaminated: boolean; requiredEnv: string[]; runnerSkillDirs?: string[];
  runnerSkillParentDirs?: string[]; failingValidatorId?: string | null; accessAuditSuspicious?: boolean;
  events?: RunEvent[]; createdAt: string; updatedAt: string;
};

type RunEvent = { phase: "setup" | "agent" | "validator" | "finish"; status: string; at: string; message?: string; exitCode?: number | null };

export type RunCaseRequest = { caseDir: string; workspaceRoot: string; home?: string; profile: string; agent: string };
export type StartManualRunRequest = Omit<RunCaseRequest, "agent"> & { contaminated?: boolean };
export type ReplayDependencies = {
  validateCaseBundle(caseDir: string): Promise<{ ok: boolean; errors: string[] }>;
  agentRunners: ReadonlyMap<string, AgentRunner>;
  runnerSkillMarkdown: string;
};

function execGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function execGitRaw(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function execGitDir(gitDir: string, args: string[]): string {
  return execFileSync("git", ["--git-dir", gitDir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function repoCacheForSubject(workspaceRoot: string, subject: JsonObject): string {
  return join(workspaceRoot, "repos", `${String(subject.repoId)}.git`);
}

function pbenchRunStateRoot(home = homedir()): string {
  return join(home, ".ya-skills", "pbench", "runs");
}

function runStatePath(home: string | undefined, runId: string): string {
  return join(pbenchRunStateRoot(home ?? homedir()), `${runId}.json`);
}

function finishingStatePath(home: string | undefined, runId: string): string {
  return `${runStatePath(home, runId)}.finishing`;
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

type InstalledRunnerSkill = { directories: string[]; createdParentDirectories: string[] };

async function installRunnerSkill(worktree: string, skillMarkdown: string): Promise<InstalledRunnerSkill> {
  const knownPaths = [
    join(worktree, ".claude"),
    join(worktree, ".claude", "skills"),
    join(worktree, ".agents"),
    join(worktree, ".agents", "skills")
  ];
  const preexistingPaths = new Set<string>();
  for (const path of knownPaths) {
    if (await pathExists(path)) {
      preexistingPaths.add(path);
    }
  }
  const targets = await detectSkillTargets(worktree);
  const directories = targets.map((target) => join(target, PBENCH_RUNNER_SKILL_NAME));
  const createdParentDirectories = [
    ...new Set(
      targets.flatMap((target) =>
        [target, dirname(target)].filter((path) => !preexistingPaths.has(path))
      )
    )
  ];
  for (const directory of directories) {
    if (await pathExists(directory)) {
      throw new Error(`Refusing to overwrite existing ${PBENCH_RUNNER_SKILL_NAME} skill: ${directory}`);
    }
  }

  const created: string[] = [];
  try {
    for (const directory of directories) {
      await mkdir(directory, { recursive: true });
      created.push(directory);
      await writeFile(join(directory, "SKILL.md"), skillMarkdown);
    }
    return { directories, createdParentDirectories };
  } catch (error) {
    await removeInstalledRunnerSkill({ directories: created, createdParentDirectories });
    throw error;
  }
}

async function removeInstalledRunnerSkill(installed: InstalledRunnerSkill): Promise<void> {
  for (const directory of installed.directories) {
    await rm(directory, { recursive: true, force: true });
  }
  const parentDirectories = [...installed.createdParentDirectories].sort((left, right) => right.length - left.length);
  for (const directory of parentDirectories) {
    try {
      await rmdir(directory);
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
      if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
        throw error;
      }
    }
  }
}

function ensureRequiredReplayEnv(manifest: JsonObject): string[] {
  const required = requiredReplayEnv(manifest);
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required replay environment variables: ${missing.join(", ")}`);
  }
  return required;
}

async function loadRunnableCase(caseDir: string, workspaceRoot: string, dependencies: ReplayDependencies): Promise<{
  manifest: JsonObject;
  caseId: string;
  repoCache: string;
  commit: string;
  requiredEnv: string[];
}> {
  const validation = await dependencies.validateCaseBundle(caseDir);
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

function makeRedactor(requiredEnv: string[], pathAliases: Array<{ actual: string; replacement: string }> = []): (text: string) => string {
  const secretReplacements = requiredEnv
    .map((name) => ({ name, value: process.env[name] }))
    .filter((item): item is { name: string; value: string } => typeof item.value === "string" && item.value.length > 0);
  const pathReplacements = pathAliases
    .filter((item) => item.actual.length > 0 && item.actual !== item.replacement)
    .sort((left, right) => right.actual.length - left.actual.length);
  return (text: string) => {
    let outputText = text;
    for (const { actual, replacement } of pathReplacements) {
      outputText = outputText.split(actual).join(replacement);
    }
    for (const { name, value } of secretReplacements) {
      outputText = outputText.split(value).join(`[REDACTED:${name}]`);
    }
    return outputText;
  };
}

function runnerPathAliases(worktree: string): Array<{ actual: string; replacement: string }> {
  try {
    const realWorktree = realpathSync(worktree);
    return [{ actual: realWorktree, replacement: worktree }];
  } catch {
    return [];
  }
}

async function saveRunState(state: RunState, home?: string): Promise<void> {
  state.updatedAt = nowIso();
  const statePath = state.status === "finishing" && !state.terminal
    ? finishingStatePath(home, state.runId)
    : runStatePath(home, state.runId);
  await writeJson(statePath, state);
  await writeJson(join(state.artifactDir, "run.json"), state);
  if (state.terminal) {
    await rm(finishingStatePath(home, state.runId), { force: true });
  }
}

async function readRunState(runId: string, home?: string): Promise<RunState> {
  try {
    return (await readJson(runStatePath(home, runId))) as RunState;
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    const state = (await readJson(finishingStatePath(home, runId))) as RunState;
    state.status = "finishing";
    return state;
  }
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
      `- Isolation: ${state.isolation}`,
      `- Attempt: ${String(state.attemptNumber)}${state.priorRunIds.length > 0 ? ` (prior: ${state.priorRunIds.join(", ")})` : ""}`,
      `- Contaminated: ${String(state.contaminated)}`,
      ...(state.failingValidatorId ? [`- Failing validator: ${state.failingValidatorId}`] : []),
      ...(state.accessAuditSuspicious ? ["- Access audit: sensitive reads flagged (access-audit.json)"] : []),
      "",
      ...details
    ].join("\n")
  );
  return path;
}

function commandVersion(command: string, args: string[] = ["--version"]): string | null {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, env: process.env }).trim() || null;
  } catch {
    return null;
  }
}

async function writeRunnerEnvironment(state: RunState, agentRunners: ReadonlyMap<string, AgentRunner>): Promise<void> {
  await writeJson(join(state.artifactDir, "runner-environment.json"), {
    schemaVersion: 1,
    runId: state.runId,
    caseId: state.caseId,
    profile: state.profile,
    agentMode: state.agentMode,
    os: {
      platform: platform(),
      release: release(),
      arch: arch()
    },
    runtime: {
      node: process.version,
      bun: commandVersion("bun", ["--version"])
    },
    tools: {
      git: commandVersion("git", ["--version"]),
      ...(agentRunners.has(state.agentMode) ? { [state.agentMode]: state.agentVersion } : {})
    },
    requiredEnv: state.requiredEnv.map((name) => ({ name, present: Boolean(process.env[name]) }))
  });
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

function setupFailureSummary(failed: ValidatorOutcome | undefined): string[] {
  return [
    "Setup failed before agent execution.",
    ...(failed
      ? [
          `- Failed setup command: ${failed.id}`,
          `- Exit code: ${String(failed.exitCode)}`,
          "- Setup outcomes: setup-outcomes.json",
          "- Candidate diff: agent.diff",
          "- Candidate files: candidate/untracked.json"
        ]
      : [])
  ];
}

function agentFailureSummary(exitCode: number | null): string[] {
  return [
    "Agent failed before private validation.",
    `- Agent exit code: ${String(exitCode)}`,
    "- Agent stdout: agent.stdout.log",
    "- Agent stderr: agent.stderr.log",
    "- Candidate diff: agent.diff",
    "- Candidate files: candidate/untracked.json"
  ];
}

function failingValidatorIdOf(outcomes: ValidatorOutcome[]): string | null {
  // null when no single validator outcome failed — including structural failures where runValidators
  // pushes an error (e.g. a manifest with no completion validator) without emitting a failing outcome.
  // A null id on a validator_failed run means "structural, no specific validator", not "unknown".
  return outcomes.find((outcome) => outcome.actual !== outcome.expected)?.id ?? null;
}

function redactedOutcomes(outcomes: ValidatorOutcome[]) {
  // Drop stdout/stderr (the per-step pass/fail sequence + diffs) so a skill-mediated agent that
  // reads validator-outcomes.json or setup-outcomes.json off disk cannot use them as an oracle.
  return outcomes.map((outcome) => ({
    id: outcome.id,
    expected: outcome.expected,
    actual: outcome.actual,
    exitCode: outcome.exitCode
  }));
}

function validatorFailureSummaryRedacted(failingValidatorId: string | null): string[] {
  return [
    "Private validators failed.",
    ...(failingValidatorId ? [`- Failed validator: ${failingValidatorId}`] : []),
    "- Candidate diff: agent.diff",
    "- Candidate files: candidate/untracked.json"
  ];
}

function validatorFailureSummary(outcomes: ValidatorOutcome[]): string[] {
  const failed = outcomes.find((outcome) => outcome.actual !== outcome.expected);
  return [
    "Private validators failed.",
    ...(failed ? [`- Failed validator: ${failed.id}`, `- Exit code: ${String(failed.exitCode)}`] : []),
    "- Validator outcomes: validator-outcomes.json",
    "- Candidate diff: agent.diff",
    "- Candidate files: candidate/untracked.json"
  ];
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
    isolation: state.isolation,
    integrity: state.integrity,
    validatorExecuted: state.validatorExecuted,
    agentVersion: state.agentVersion,
    attemptNumber: state.attemptNumber,
    priorRunIds: state.priorRunIds,
    contaminated: state.contaminated,
    failingValidatorId: state.failingValidatorId ?? null,
    accessAuditSuspicious: state.accessAuditSuspicious === true,
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
  for (const target of [join(".claude", "skills"), join(".agents", "skills")]) {
    const runnerSkillPath = join(options.worktree, target, PBENCH_RUNNER_SKILL_NAME, "SKILL.md");
    if (await pathExists(runnerSkillPath)) {
      surfaces.push({ label: join(target, PBENCH_RUNNER_SKILL_NAME, "SKILL.md"), text: await readFile(runnerSkillPath, "utf8") });
    }
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

async function writeAgentDiff(
  worktree: string,
  artifactDir: string,
  redactor: (text: string) => string = (text) => text
): Promise<string> {
  const tracked = execGitRaw(worktree, ["diff", "--binary", "HEAD", "--", "."]);
  const untracked = execGit(worktree, ["ls-files", "--others", "--exclude-standard"])
    .split(/\r?\n/)
    .map((file) => file.trim())
    .filter((file) => file.length > 0)
    .sort((left, right) => left.localeCompare(right));
  const visibleUntracked = untracked.filter((file) => !file.startsWith(".pbench/"));
  const untrackedSection =
    visibleUntracked.length > 0
      ? ["", "Untracked files:", ...visibleUntracked.map((file) => `- ${file}`), ""].join("\n")
      : "";
  const diff = `${tracked}${untrackedSection}`;
  const path = join(artifactDir, "agent.diff");
  await writeFile(path, redactor(diff));
  await writeCandidateArtifacts({ worktree, artifactDir, tracked, untracked, redactor });
  return path;
}

async function writeCandidateArtifacts(options: {
  worktree: string;
  artifactDir: string;
  tracked: string;
  untracked: string[];
  redactor: (text: string) => string;
}): Promise<void> {
  const candidateDir = join(options.artifactDir, "candidate");
  const copiedRoot = join(candidateDir, "untracked");
  const files: JsonObject[] = [];
  await mkdir(copiedRoot, { recursive: true });
  await writeFile(join(candidateDir, "tracked.diff"), options.redactor(options.tracked));
  for (const file of options.untracked) {
    const safe = safeRelativePath(file);
    if (!safe) {
      files.push({ path: file, status: "skipped", reason: "unsafe path" });
      continue;
    }
    if (safe.startsWith(".pbench/")) {
      files.push({ path: safe, status: "skipped", reason: ".pbench" });
      continue;
    }
    const sourcePath = join(options.worktree, safe);
    const info = await stat(sourcePath).catch(() => null);
    if (!info?.isFile()) {
      files.push({ path: safe, status: "skipped", reason: "not a file" });
      continue;
    }
    if (info.size > MAX_PUBLIC_TEXT_FILE_BYTES) {
      files.push({ path: safe, status: "skipped", reason: "large file", sizeBytes: info.size });
      continue;
    }
    const bytes = await readFile(sourcePath);
    if (!isUtf8Text(bytes)) {
      files.push({ path: safe, status: "skipped", reason: "binary file", sizeBytes: info.size });
      continue;
    }
    const destination = join(copiedRoot, safe);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, options.redactor(decodeUtf8Text(bytes)));
    files.push({ path: safe, status: "copied", sizeBytes: info.size, artifactPath: `candidate/untracked/${safe}` });
  }
  await writeJson(join(candidateDir, "untracked.json"), {
    schemaVersion: 1,
    files
  });
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

async function createStartedRun(options: {
  caseDir: string;
  workspaceRoot: string;
  home?: string;
  agentMode: string;
  profile: string;
  contaminated?: boolean;
}, dependencies: ReplayDependencies): Promise<{ state: RunState; manifest: JsonObject; redactor: (text: string) => string }> {
  const { manifest, caseId, repoCache, commit, requiredEnv } = await loadRunnableCase(
    options.caseDir,
    options.workspaceRoot,
    dependencies
  );
  const runId = makeRunId(caseId);
  const artifactDir = join(options.workspaceRoot, "runs", runId);
  await mkdir(artifactDir, { recursive: true });
  const worktree = await createReplayWorktree(repoCache, commit, options.workspaceRoot, runId);
  const redactor = makeRedactor(requiredEnv, runnerPathAliases(worktree));
  const prior = await priorAttempts(options.workspaceRoot, caseId, options.profile);
  let isolation: PbenchIsolation = "none";
  if (options.agentMode !== "skill") {
    isolation = dependencies.agentRunners.get(options.agentMode)?.defaultIsolation ?? "none";
  }
  const contaminated = options.contaminated === true;
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
    isolation,
    integrity: contaminated ? "contaminated" : "instruction-only",
    validatorExecuted: false,
    agentVersion: dependencies.agentRunners.get(options.agentMode)?.versionProbe(process.env) ?? null,
    attemptNumber: prior.runIds.length + 1,
    priorRunIds: prior.runIds,
    contaminated,
    requiredEnv,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };

  let installedRunnerSkill: InstalledRunnerSkill = { directories: [], createdParentDirectories: [] };
  try {
    await writeRunnerEnvironment(state, dependencies.agentRunners);
    await preparePublicCapsule(options.caseDir, manifest, worktree, runId);
    await applyStartingPatch(options.caseDir, worktree);
    const setupOutcomes = runSetupCommands(manifest, worktree, publicRunnerEnv(worktree));
    state.events = [setupRunEvent(setupOutcomes)];
    if (setupOutcomes.length > 0) {
      const setupForDisk = options.agentMode === "skill" ? redactedOutcomes(setupOutcomes) : setupOutcomes;
      await writeFile(join(artifactDir, "setup-outcomes.json"), redactor(JSON.stringify(setupForDisk, null, 2)));
      const failed = setupOutcomes.find((outcome) => outcome.actual !== "pass");
      if (failed) {
        state.status = "setup_failed";
        state.terminal = true;
        state.finishedAt = nowIso();
        await writeAgentDiff(worktree, artifactDir, redactor);
        await writeRunSummary(state, setupFailureSummary(failed));
        await writeTerminalRunArtifacts(state, {
          events: [...(state.events ?? []), runEvent("finish", "setup_failed", { message: "Setup failed before agent execution." })]
        });
        await saveRunState(state, options.home);
        await cleanupReplayWorktree(repoCache, worktree);
        return { state, manifest, redactor };
      }
    }
    if (options.agentMode === "skill") {
      installedRunnerSkill = await installRunnerSkill(worktree, dependencies.runnerSkillMarkdown);
      state.runnerSkillDirs = installedRunnerSkill.directories;
      state.runnerSkillParentDirs = installedRunnerSkill.createdParentDirectories;
    }
    await assertPreparedAgentVisibleInputs({ worktree, caseDir: options.caseDir, agentPrompt: renderAgentPrompt() });
    await saveRunState(state, options.home);
    return { state, manifest, redactor };
  } catch (error) {
    try {
      await removeInstalledRunnerSkill(installedRunnerSkill);
    } finally {
      await cleanupReplayWorktree(repoCache, worktree);
    }
    throw error;
  }
}

async function completeRunWithValidators(state: RunState, manifest: JsonObject, home?: string): Promise<RunState> {
  const errors: string[] = [];
  const redactor = makeRedactor(state.requiredEnv, runnerPathAliases(state.worktree));
  state.validatorExecuted = true;
  await saveRunState(state, home);
  const outcomes = await runValidators({
    caseDir: state.caseDir,
    manifest,
    replayRoot: state.worktree,
    env: privateValidatorEnv(state.caseDir, state.worktree),
    expectedMode: "candidate",
    errors
  });
  const passed = errors.length === 0;
  const failingValidatorId = failingValidatorIdOf(outcomes);
  state.failingValidatorId = failingValidatorId;
  // Skill-mediated runs are unsandboxed, so persisted validator step output (stdout/stderr) is an
  // iteration oracle if left in the agent-readable run dir. Persist only a per-validator pass/fail
  // summary there; sandboxed codex runs keep the full outcomes. See docs/pbench-leak-handoff.md P1.1.
  const skillMode = state.agentMode === "skill";
  const outcomesForDisk = skillMode ? redactedOutcomes(outcomes) : outcomes;
  await writeFile(join(state.artifactDir, "validator-outcomes.json"), redactor(`${JSON.stringify(outcomesForDisk, null, 2)}\n`));
  await writeAgentDiff(state.worktree, state.artifactDir, redactor);
  state.status = passed ? "passed" : "validator_failed";
  state.terminal = true;
  state.finishedAt = nowIso();
  let summaryDetails: string[];
  if (passed) {
    summaryDetails = ["Private validators passed."];
  } else if (skillMode) {
    summaryDetails = validatorFailureSummaryRedacted(failingValidatorId);
  } else {
    summaryDetails = validatorFailureSummary(outcomes);
  }
  await writeRunSummary(state, summaryDetails);
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

async function runCase(options: RunCaseRequest, dependencies: ReplayDependencies): Promise<JsonObject> {
  const agent = options.agent ?? "codex";
  const runner = dependencies.agentRunners.get(agent);
  if (!runner) {
    throw new Error(`Unknown agent runner "${agent}". Known agents: ${[...dependencies.agentRunners.keys()].join(", ")}.`);
  }
  const { state, manifest, redactor } = await createStartedRun({ ...options, agentMode: agent }, dependencies);
  if (state.terminal) {
    return { runId: state.runId, status: state.status, artifactDir: state.artifactDir, summaryPath: join(state.artifactDir, "summary.md") };
  }
  const prompt = renderAgentPrompt();
  await writeFile(join(state.artifactDir, "agent-stdin.txt"), redactor(prompt));
  const startedAt = Date.now();
  const agentResult = runner.launch({
    worktree: state.worktree,
    prompt,
    env: publicRunnerEnv(state.worktree),
    timeoutMs: 30 * 60 * 1000
  });
  const durationMs = Date.now() - startedAt;
  await writeFile(join(state.artifactDir, "agent.stdout.log"), redactor(agentResult.stdout));
  await writeFile(join(state.artifactDir, "agent.stderr.log"), redactor(agentResult.stderr));
  await writeFile(join(state.artifactDir, "agent.jsonl"), redactor(agentResult.stdout));
  const agentSummary = runner.parseSummary(agentResult.stdout);
  if (agentSummary.lastMessage) {
    await writeFile(join(state.artifactDir, "agent-last-message.md"), redactor(agentSummary.lastMessage));
  }
  await copyAgentProbeFiles(state.worktree, state.artifactDir, redactor);
  state.agentExitCode = agentResult.exitCode;
  state.durationMs = durationMs;
  state.cost = agentSummary.cost ?? null;
  state.tokenUsage = agentSummary.tokenUsage;
  state.events = [
    ...(state.events ?? []),
    runEvent("agent", agentResult.exitCode === 0 ? "passed" : "failed", {
      exitCode: agentResult.exitCode,
      message: agentResult.exitCode === 0 ? "Agent completed." : "Agent failed before private validation."
    })
  ];
  if (agentResult.exitCode !== 0) {
    state.status = "agent_failed";
    state.terminal = true;
    state.finishedAt = nowIso();
    await writeAgentDiff(state.worktree, state.artifactDir, redactor);
    await writeRunSummary(state, agentFailureSummary(agentResult.exitCode));
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

async function startManualRun(options: StartManualRunRequest, dependencies: ReplayDependencies): Promise<JsonObject> {
  const { state } = await createStartedRun({ ...options, agentMode: "skill" }, dependencies);
  return {
    runId: state.runId,
    status: state.status,
    worktree: state.worktree,
    artifactDir: state.artifactDir,
    finishCommand: `yk pbench finish --run ${state.runId}`
  };
}

function sensitiveAccessReadKind(path: string): string | null {
  if (/(^|[/\\])private([/\\]|$)/.test(path)) return "private-evidence";
  if (/(^|[/\\])runs([/\\]|$)/.test(path)) return "prior-run-artifacts";
  if (/[/\\]functions-pbench[/\\]src/.test(path) || /[/\\]functions-pbench[/\\]/.test(path)) return "harness-source";
  // Match the capture/authoring skill source (skills/pbench/...), NOT the runner skill the agent
  // is required to read (skills/pbench-runner/...) — "pbench" must be followed by a separator or end.
  if (/[/\\]skills[/\\]pbench(?:[/\\]|$)/.test(path)) return "pbench-skill-source";
  if (/(^|[/\\])case\.json$/.test(path)) return "case-manifest";
  return null;
}

async function summarizeAccessAudit(worktree: string): Promise<{ readCount: number; sensitiveReads: { path: string; kind: string }[]; suspicious: boolean } | null> {
  const logPath = join(worktree, ".pbench", "access-audit.jsonl");
  if (!(await pathExists(logPath))) {
    return null;
  }
  const text = await readFile(logPath, "utf8");
  const sensitiveReads: { path: string; kind: string }[] = [];
  let readCount = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    readCount += 1;
    let entry: { path?: unknown } = {};
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const readPath = typeof entry.path === "string" ? entry.path : "";
    const kind = sensitiveAccessReadKind(readPath);
    if (kind) {
      sensitiveReads.push({ path: readPath, kind });
    }
  }
  return { readCount, sensitiveReads, suspicious: sensitiveReads.length > 0 };
}

async function acquireFinishingState(runId: string, home?: string): Promise<RunState> {
  try {
    await rename(runStatePath(home, runId), finishingStatePath(home, runId));
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    const existing = await readRunState(runId, home);
    throw new Error(`PBench run already finished: ${existing.runId} (${existing.status})`);
  }
  const state = (await readJson(finishingStatePath(home, runId))) as RunState;
  state.status = "finishing";
  await saveRunState(state, home);
  return state;
}

async function finishRun(options: { runId: string; home?: string }): Promise<JsonObject> {
  const initial = await readRunState(options.runId, options.home);
  if (initial.terminal || initial.status !== "running") {
    throw new Error(`PBench run already finished: ${initial.runId} (${initial.status})`);
  }
  const state = await acquireFinishingState(options.runId, options.home);

  try {
    await removeInstalledRunnerSkill({
      directories: state.runnerSkillDirs ?? [],
      createdParentDirectories: state.runnerSkillParentDirs ?? []
    });
    const manifest = await readJson(join(state.caseDir, "case.json"));
    // P1.3-lite: copy the skill agent's voluntary access-audit log out of the worktree BEFORE
    // completeRunWithValidators deletes the worktree, and flag sensitive reads for post-hoc review.
    const accessAudit = await summarizeAccessAudit(state.worktree);
    if (accessAudit) {
      state.accessAuditSuspicious = accessAudit.suspicious;
      await writeJson(join(state.artifactDir, "access-audit.json"), accessAudit);
    }
    const finished = await completeRunWithValidators(state, manifest, options.home);
    // Skill finish returns only terminal status; validator identities remain private.
    return { runId: finished.runId, status: finished.status };
  } catch {
    state.status = "blocked";
    state.terminal = true;
    state.finishedAt = nowIso();
    await writeRunSummary(state, ["Run blocked by validation infrastructure."]);
    await saveRunState(state, options.home);
    await cleanupReplayWorktree(state.repoCache, state.worktree);
    return { runId: state.runId, status: state.status };
  }
}

// O(runs): scans the workspace run directory on every start so attemptNumber/priorRunIds reflect
// real history. Acceptable for personal-bench scale; revisit if workspaces grow very large.
async function priorAttempts(workspaceRoot: string, caseId: string, profile: string): Promise<{ runIds: string[] }> {
  const runsRoot = join(workspaceRoot, "runs");
  if (!(await pathExists(runsRoot))) {
    return { runIds: [] };
  }
  const entries = await readdir(runsRoot, { withFileTypes: true });
  const runIds: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const runJsonPath = join(runsRoot, entry.name, "run.json");
    if (!(await pathExists(runJsonPath))) {
      continue;
    }
    try {
      const run = await readJson(runJsonPath);
      const sameCase = String(run.caseId ?? "") === caseId;
      const sameProfile = normalizeRunProfile(typeof run.profile === "string" ? run.profile : undefined) === profile;
      // Count only prior runs that COMPLETED (terminal) under the new accounting (carry attemptNumber),
      // so in-flight runs and legacy pre-feature runs don't inflate the attempt counter.
      const isCountedPrior = run.terminal === true && typeof run.attemptNumber === "number";
      if (sameCase && sameProfile && isCountedPrior) {
        runIds.push(String(run.runId ?? entry.name));
      }
    } catch {
      // Ignore malformed prior run artifacts — they cannot be reliable prior attempts.
    }
  }
  return { runIds };
}

export function createReplay(dependencies: ReplayDependencies) {
  return {
    runCase: (request: RunCaseRequest) => runCase(request, dependencies),
    startManualRun: (request: StartManualRunRequest) => startManualRun(request, dependencies),
    finishRun
  };
}
