import { randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { JsonObject } from "./adapters/types.js";
import { asArray, asObject, pathExists, safeRelativePath, slugify, stamp } from "./shared.js";
import type { ValidatorOutcome } from "./run-types.js";

function execGitDir(gitDir: string, args: string[]): string {
  return execFileSync("git", ["--git-dir", gitDir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function repoCacheForSubject(workspaceRoot: string, subject: JsonObject): string {
  return join(workspaceRoot, "repos", `${String(subject.repoId)}.git`);
}

export async function createReplayWorktree(
  repoCache: string,
  commit: string,
  workspaceRoot: string,
  runId: string
): Promise<string> {
  const runRoot = join(workspaceRoot, ".personal-bench", "replays", runId);
  const worktree = join(runRoot, "worktree");
  await rm(runRoot, { recursive: true, force: true });
  await mkdir(runRoot, { recursive: true });
  execGitDir(repoCache, ["worktree", "add", "--detach", worktree, commit]);
  return worktree;
}

export async function cleanupReplayWorktree(repoCache: string, worktree: string): Promise<void> {
  try {
    execGitDir(repoCache, ["worktree", "remove", "--force", worktree]);
  } catch {
    // Fall through to filesystem cleanup.
  }
  await rm(basename(worktree) === "worktree" ? dirname(worktree) : worktree, { recursive: true, force: true });
}

function runShell(command: string, cwd: string, timeoutSeconds: number, env: NodeJS.ProcessEnv): ValidatorOutcome {
  const result = spawnSync(command, { cwd, shell: true, encoding: "utf8", timeout: timeoutSeconds * 1000, env });
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

export function privateValidatorEnv(caseDir: string, worktree: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PB_CASE_DIR: caseDir,
    PB_PUBLIC_DIR: join(caseDir, "public"),
    PB_PRIVATE_DIR: join(caseDir, "private"),
    PB_REPLAY_DIR: worktree
  };
}

export function runSetupCommands(
  manifest: JsonObject,
  worktree: string,
  env: NodeJS.ProcessEnv
): ValidatorOutcome[] {
  const outcomes: ValidatorOutcome[] = [];
  for (const setup of asArray(manifest.setupCommands)) {
    const command = String(setup.command ?? "");
    if (!command) continue;
    const cwd = join(worktree, safeRelativePath(setup.cwd ?? ".") ?? ".");
    const outcome = runShell(command, cwd, Number(setup.timeoutSeconds ?? 300), env);
    outcome.id = command;
    outcome.expected = "pass";
    outcomes.push(outcome);
    if (outcome.actual !== "pass") break;
  }
  return outcomes;
}

export async function runValidators(options: {
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
    let expected: ValidatorOutcome["expected"] = "pass";
    if (options.expectedMode === "baseline" && validator.baselineExpected !== "pass") expected = "fail";

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

export async function validateReplayBaseline(options: {
  caseDir: string;
  manifest: JsonObject;
  workspaceRoot: string;
  errors: string[];
}): Promise<ValidatorOutcome[]> {
  const subject = asArray(options.manifest.subjects)[0];
  if (!subject) {
    options.errors.push("V1 requires exactly one git subject.");
    return [];
  }
  const baseline = asObject(subject.baseline);
  const commit = String(baseline?.commit ?? "");
  const repoCache = repoCacheForSubject(options.workspaceRoot, subject);
  if (!(await pathExists(repoCache))) {
    options.errors.push(`Missing repo cache: ${repoCache}`);
    return [];
  }
  try {
    execGitDir(repoCache, ["cat-file", "-e", `${commit}^{commit}`]);
  } catch {
    options.errors.push(`Baseline commit not present in repo cache: ${commit}`);
    return [];
  }
  if (baseline?.ref) {
    try {
      const refCommit = execGitDir(repoCache, ["rev-parse", String(baseline.ref)]);
      if (refCommit !== commit) {
        options.errors.push(`Baseline ref ${String(baseline.ref)} points to ${refCommit}, expected ${commit}`);
      }
    } catch {
      options.errors.push(`Missing baseline ref: ${String(baseline.ref)}`);
    }
  }
  if (options.errors.length > 0) return [];

  const replayRoot = await createReplayWorktree(
    repoCache,
    commit,
    options.workspaceRoot,
    `strict_${slugify(String(options.manifest.id ?? "case"))}_${stamp()}_${randomBytes(4).toString("hex")}`
  );
  const outcomes: ValidatorOutcome[] = [];
  try {
    const env = privateValidatorEnv(options.caseDir, replayRoot);
    for (const setupOutcome of runSetupCommands(options.manifest, replayRoot, env)) {
      if (setupOutcome.actual !== "pass") {
        options.errors.push(`Setup command failed: ${setupOutcome.id}\n${setupOutcome.stderr || setupOutcome.stdout}`);
        return outcomes;
      }
    }
    outcomes.push(...await runValidators({
      caseDir: options.caseDir,
      manifest: options.manifest,
      replayRoot,
      env,
      expectedMode: "baseline",
      errors: options.errors
    }));
    return outcomes;
  } finally {
    await cleanupReplayWorktree(repoCache, replayRoot);
  }
}
