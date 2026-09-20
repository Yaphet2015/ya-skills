import type { JsonObject, NormalizedSession } from "./adapters/types.js";
import { execGit, execGitRaw } from "./git.js";
import { asObject, isUtf8Text, safeRelativePath, writeJson } from "./shared.js";
import { dirname, join } from "node:path";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";

const MAX_PUBLIC_TEXT_FILE_BYTES = 64 * 1024;

export const PUBLIC_KEY_OBSERVATIONS_PATH = "public/key-observations.md";
export const PUBLIC_COMMAND_OBSERVATIONS_PATH = "public/command-observations.md";

export function commandText(record: JsonObject): string {
  const args = asObject(record.arguments) ?? {};
  return String(args.cmd ?? args.command ?? record.command ?? "");
}

export function fenced(text: string): string {
  return ["```text", text, "```"].join("\n");
}

export function excerpt(text: string, maxLength = 2000): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n[truncated]` : text;
}

export async function writeObservationDocument(
  caseDir: string,
  extracted: NormalizedSession,
  sanitizePublicText: (text: string) => string,
  kind: "key" | "all"
): Promise<string> {
  const keyOnly = kind === "key";
  const outputPath = keyOnly ? PUBLIC_KEY_OBSERVATIONS_PATH : PUBLIC_COMMAND_OBSERVATIONS_PATH;
  const records = extracted.toolCalls
    .filter((record) => commandText(record))
    .filter((record) => !keyOnly || isKeyObservationRecord(record));
  const lines = [`# ${keyOnly ? "Key" : "Command"} Observations`, ""];
  if (records.length === 0) {
    lines.push(keyOnly ? "No key command observations captured." : "No command-like tool calls captured.", "");
  }
  for (const [index, record] of records.entries()) {
    const args = asObject(record.arguments) ?? {};
    const command = sanitizePublicText(commandText(record));
    const cwd = sanitizePublicText(String(args.cwd ?? args.workdir ?? record.cwd ?? record.workdir ?? "unknown"));
    lines.push(`## ${index + 1}. ${command}`, "");
    lines.push(`- cwd: ${cwd}`);
    lines.push(`- status: ${String(record.status ?? record.outcome ?? "unknown")}`);
    lines.push(`- exitCode: ${String(record.exit_code ?? record.exitCode ?? "unknown")}`);
    const stdout = excerpt(sanitizePublicText(String(record.stdout ?? "")));
    const stderr = excerpt(sanitizePublicText(String(record.stderr ?? "")));
    if (stdout) lines.push("", "stdout:", fenced(stdout));
    if (stderr) lines.push("", "stderr:", fenced(stderr));
    lines.push("");
  }
  await writeFile(join(caseDir, outputPath), lines.join("\n"));
  return outputPath;
}

function isKeyObservationRecord(record: JsonObject): boolean {
  const command = commandText(record).trim();
  if (!command || isSkippedObservationCommand(command)) return false;
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
  if (lower.includes("yk pbench export-replay")) return true;
  if (lower.includes("superpowers") && (lower.includes("use-skill") || lower.includes("bootstrap") || lower.includes("/skills/"))) {
    return true;
  }
  return lower.includes("/skills/") && lower.includes("skill.md") && /^(sed|cat|bat|less)\b/.test(lower);
}

export function isReplayableVerificationCommand(command: string): boolean {
  if (!command || /[;&|<>`$]/.test(command)) return false;
  return /^(bun|npm|pnpm|yarn)\b/.test(command) && /\b(test|typecheck|build|lint|check|verify)\b/.test(command);
}

export async function captureReplayStartCandidates(
  caseDir: string,
  repoRoot: string,
  warnings: string[]
): Promise<{
  status: "clean" | "unresolved";
  candidateTrackedPatch?: "private/artifacts/extracted/starting.patch";
  candidateUntrackedManifest?: "private/artifacts/extracted/untracked.manifest.json";
}> {
  const replayStart: {
    status: "clean" | "unresolved";
    candidateTrackedPatch?: "private/artifacts/extracted/starting.patch";
    candidateUntrackedManifest?: "private/artifacts/extracted/untracked.manifest.json";
  } = { status: "clean" };
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
  if (files.length === 0) return replayStart;

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
  return replayStart;
}

export async function writeFailureDraft(caseDir: string, extracted: NormalizedSession): Promise<void> {
  const laterUserMessages = extracted.userMessages.slice(1);
  const lines = [
    "# Failure Draft",
    "",
    "This draft is generated from deterministic capture heuristics. Rewrite `private/failure.md` with the final failure statement.",
    ""
  ];
  if (laterUserMessages.length > 0) {
    lines.push("## Later User Corrections", "", ...laterUserMessages.map((message) => `- ${message.replace(/\s+/g, " ").trim()}`), "");
  }
  if (extracted.errorRecords.length > 0) {
    lines.push(
      "## Error Records",
      "",
      ...extracted.errorRecords.map((record) => {
        const command = commandText(record);
        const exitCode = record.exit_code ?? record.exitCode ?? "unknown";
        const stderr = excerpt(String(record.stderr ?? ""), 500).replace(/\s+/g, " ").trim();
        return `- ${command ? `${command}: ` : ""}exitCode=${String(exitCode)}${stderr ? ` stderr=${stderr}` : ""}`;
      }),
      ""
    );
  }
  if (laterUserMessages.length === 0 && extracted.errorRecords.length === 0) {
    lines.push("No obvious user correction or command failure was detected. Inspect the raw transcript before finalizing the case.", "");
  }
  await writeFile(join(caseDir, "private", "failure-draft.md"), lines.join("\n"));
}
