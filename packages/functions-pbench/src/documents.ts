import type { JsonObject, NormalizedSession } from "./adapters/types.js";
import { asObject, safeRelativePath } from "./shared.js";
import {
  commandText,
  excerpt,
  fenced,
  isReplayableVerificationCommand
} from "./observations.js";
import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

export const VALIDATOR_AUTHORING_SENTINEL = "PBENCH_AUTHORING_REQUIRED";

export type GeneratedAuthoringArtifacts = {
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

export function selectedTaskTitle(extracted: NormalizedSession): string | null {
  const first = extracted.userMessages[0]?.split(/\r?\n/)[0]?.trim();
  return first ? first.slice(0, 80) : null;
}

export function buildAuthoringArtifacts(
  title: string,
  extracted: NormalizedSession,
  sourceRepoRoot: string
): GeneratedAuthoringArtifacts {
  const prompt = extracted.userMessages[0]?.trim() ?? "";
  const corrections = extracted.userMessages.slice(1).map(evidenceLine).filter(Boolean);
  const errors = extracted.errorRecords.map(errorEvidenceLine).filter(Boolean);
  const failedVerification = findFailedVerificationCommand(extracted, sourceRepoRoot);

  return {
    failure: renderFailureDocument(corrections, errors),
    success: renderSuccessDocument(title, prompt, corrections),
    verification: renderVerificationDocument(failedVerification),
    validatorCwd: failedVerification?.replayCwd ?? ".",
    hasFailureEvidence: corrections.length > 0 || errors.length > 0,
    hasPrompt: prompt.length > 0,
    validatorScript: failedVerification?.replayCwd
      ? renderCommandValidatorScript(failedVerification.command)
      : renderAuthoringRequiredValidatorScript()
  };
}

function renderFailureDocument(corrections: string[], errors: string[]): string {
  const lines = ["# Failure", "", "Generated from captured coding-agent session history.", ""];
  if (corrections.length > 0) lines.push("## User Correction Evidence", "", ...corrections.map((message) => `- ${message}`), "");
  if (errors.length > 0) lines.push("## Command/Error Evidence", "", ...errors.map((message) => `- ${message}`), "");
  if (corrections.length === 0 && errors.length === 0) {
    lines.push(
      "No failure evidence was detected in the captured session. Ask for the task/session-level outcome mismatch before finalizing.",
      ""
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderSuccessDocument(title: string, prompt: string, corrections: string[]): string {
  const lines = ["# Success Criteria", "", "Generated from captured coding-agent session history.", ""];
  const task = prompt || title;
  if (task) {
    lines.push("A future agent succeeds when it completes the captured task:", "", `- ${evidenceLine(task)}`, "");
  } else {
    lines.push("No original task prompt was captured. Ask for observable success criteria before finalizing.", "");
  }
  if (corrections.length > 0) {
    lines.push("It must also resolve the captured correction evidence:", "", ...corrections.map((message) => `- ${message}`), "");
  }
  lines.push("Completion must be demonstrated by the completion validator.");
  return `${lines.join("\n")}\n`;
}

function renderVerificationDocument(command: VerificationCommand | null): string {
  const lines = ["# Verification", "", "Generated from captured coding-agent session history.", ""];
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
    if (command.stderr) lines.push("Captured failure stderr:", "", fenced(command.stderr), "");
    if (command.stdout) lines.push("Captured failure stdout:", "", fenced(command.stdout), "");
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
  if (!cwd || cwd === "unknown") return { replayCwd: "." };
  if (isAbsolute(cwd)) {
    const relativeCwd = relative(realPathOrResolved(sourceRepoRoot), realPathOrResolved(cwd)).replace(/\\/g, "/");
    if (relativeCwd === "") return { replayCwd: "." };
    if (!relativeCwd.startsWith("../") && relativeCwd !== ".." && !isAbsolute(relativeCwd)) {
      return { replayCwd: relativeCwd };
    }
    return { replayCwd: null, unsafeReason: "cwd is outside the captured subject repository" };
  }
  const safe = safeRelativePath(cwd);
  return safe ? { replayCwd: safe } : { replayCwd: null, unsafeReason: "cwd is not a safe repo-relative path" };
}

function findFailedVerificationCommand(extracted: NormalizedSession, sourceRepoRoot: string): VerificationCommand | null {
  const candidates: VerificationCommand[] = [];
  for (const record of extracted.errorRecords) {
    const command = commandText(record).trim();
    if (!isReplayableVerificationCommand(command)) continue;
    const args = asObject(record.arguments) ?? {};
    const cwd = String(args.cwd ?? args.workdir ?? record.cwd ?? record.workdir ?? ".");
    candidates.push({
      command,
      cwd,
      ...replayCwdFromCapturedCwd(cwd, sourceRepoRoot),
      stdout: excerpt(String(record.stdout ?? ""), 1000),
      stderr: excerpt(String(record.stderr ?? ""), 1000)
    });
  }
  return candidates.at(-1) ?? null;
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
  const stderr = evidenceLine(String(record.stderr ?? ""));
  const stdout = evidenceLine(String(record.stdout ?? ""));
  return [command ? `${command}:` : "", `exitCode=${String(exitCode)}`, stderr ? `stderr=${stderr}` : "", stdout ? `stdout=${stdout}` : ""]
    .filter(Boolean)
    .join(" ");
}

export async function writeAuthoringChecklist(
  path: string,
  options: {
    authoring: GeneratedAuthoringArtifacts;
    setupCommands: JsonObject[];
    replayWarnings: string[];
    replayStart: { status: "clean" | "unresolved" | "baseline" | "curated" };
  }
): Promise<void> {
  const generated = options.authoring.validatorScript.includes(VALIDATOR_AUTHORING_SENTINEL)
    ? "needs manual authoring"
    : `generated command validator (cwd: ${options.authoring.validatorCwd})`;
  const setup = options.setupCommands.length > 0
    ? options.setupCommands.map((command) => `${String(command.command)} (cwd: ${String(command.cwd ?? ".")})`).join(", ")
    : "none detected";
  const replayWarnings = options.replayWarnings.length > 0
    ? options.replayWarnings.map((warning) => `  - ${warning}`).join("\n")
    : "  - none";
  const replayStart = options.replayStart.status === "unresolved"
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

export async function findAuthoringWarnings(caseDir: string): Promise<string[]> {
  const warnings: string[] = [];
  const prompt = await readFile(join(caseDir, "public/prompt.md"), "utf8");
  if (prompt.trim().length === 0) warnings.push("public/prompt.md is empty");
  const commandObservations = await readFile(join(caseDir, "public/command-observations.md"), "utf8");
  if (commandObservations.includes("No command-like tool calls captured.")) {
    warnings.push("public/command-observations.md has no command-like tool calls");
  }
  const failureDraft = await readFile(join(caseDir, "private/failure-draft.md"), "utf8");
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
    if (content.includes("TODO")) warnings.push(`${path} still contains TODO`);
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
