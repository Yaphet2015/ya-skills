import { join } from "node:path";
import { asObject, findSessionFileByName, isErrorRecord, parseJsonlLines } from "./shared.js";
import type { JsonObject, NormalizedSession, SessionSource } from "./types.js";

export function createClaudeSessionSource(): SessionSource {
  return {
    id: "claude",
    sourceKind: "claude-session",
    locate: locateClaudeSession,
    extract: extractClaudeSession
  };
}

async function locateClaudeSession(options: { sessionId?: string; home: string }): Promise<string> {
  if (!options.sessionId) {
    throw new Error("Capturing a Claude Code session requires --session-id <id> or --input <transcript>.");
  }
  const path = await findSessionFileByName(join(options.home, ".claude", "projects"), options.sessionId);
  if (!path) {
    throw new Error(
      `No Claude Code transcript found for session id "${options.sessionId}". Pass --input <jsonl> to capture it directly.`
    );
  }
  return path;
}

function extractClaudeSession(rawText: string): NormalizedSession {
  const records = parseJsonlLines(rawText);
  const userMessages: string[] = [];
  const assistantMessages: string[] = [];
  const toolCalls: JsonObject[] = [];
  const errorRecords: JsonObject[] = [];
  const approvalSandboxRecords: JsonObject[] = [];
  const touched = new Set<string>();
  const timeline: string[] = [];
  const toolResultsById = new Map<string, JsonObject>();

  for (const record of records) {
    const message = asObject(record.message);
    if (record.type !== "user" || !message || !Array.isArray(message.content)) continue;
    for (const rawBlock of message.content) {
      const block = asObject(rawBlock);
      if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
        toolResultsById.set(block.tool_use_id, block);
      }
    }
  }

  let metaCwd: string | undefined;
  let metaId: string | undefined;
  let metaModel: string | undefined;
  let metaBranch: string | undefined;

  for (const [index, record] of records.entries()) {
    const type = String(record.type ?? "");
    if (typeof record.cwd === "string" && !metaCwd) metaCwd = record.cwd;
    if (typeof record.sessionId === "string" && !metaId) metaId = record.sessionId;
    if (typeof record.gitBranch === "string" && !metaBranch) metaBranch = record.gitBranch;
    const message = asObject(record.message);

    if (type === "user" && message && typeof message.content === "string") {
      const text = message.content;
      if (text.trim() && !isInjectedClaudeContext(text)) {
        userMessages.push(text);
        timeline.push(`- ${index + 1}. user: ${text.slice(0, 200).replace(/\s+/g, " ")}`);
      }
    }

    if (type === "assistant" && message) {
      if (typeof message.model === "string" && !metaModel) metaModel = message.model;
      const content = Array.isArray(message.content) ? message.content : [];
      for (const rawBlock of content) {
        const block = asObject(rawBlock);
        if (!block) continue;
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          assistantMessages.push(block.text);
        }
        if (block.type !== "tool_use") continue;

        const name = String(block.name ?? "");
        const input = asObject(block.input) ?? {};
        const callId = typeof block.id === "string" ? block.id : null;
        const command = typeof input.command === "string" ? input.command : typeof input.cmd === "string" ? input.cmd : undefined;
        const filePath = typeof input.file_path === "string" ? input.file_path : typeof input.path === "string" ? input.path : undefined;
        const toolCall: JsonObject = {
          type: "tool_call",
          name,
          call_id: callId,
          command,
          arguments: input,
          cwd: metaCwd
        };
        if (filePath) {
          toolCall.file_path = filePath;
          touched.add(filePath);
        }
        const result = callId ? toolResultsById.get(callId) : undefined;
        if (result) {
          const outputText = claudeToolResultText(result);
          if (outputText) toolCall.stdout = outputText;
          const exitCode = claudeToolResultExitCode(result);
          if (exitCode !== null) {
            toolCall.exit_code = exitCode;
            toolCall.status = exitCode === 0 ? "success" : "failed";
          } else if (result.is_error === true) {
            toolCall.status = "failed";
          }
          if (isErrorRecord(toolCall)) errorRecords.push(toolCall);
        }
        toolCalls.push(toolCall);
        timeline.push(`- ${index + 1}. tool: ${name}${command ? `: ${command.slice(0, 120)}` : ""}`);
      }
    }

    if (type === "permission-mode" || type === "mode") approvalSandboxRecords.push(record);
  }

  const meta: JsonObject = { cwd: metaCwd, id: metaId, model: metaModel, cli_version: "claude-code" };
  if (metaBranch) meta.git = { branch: metaBranch };
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

function isInjectedClaudeContext(content: string): boolean {
  const trimmed = content.trimStart();
  return (
    trimmed.startsWith("Caveat:") ||
    trimmed.startsWith("<command-name>") ||
    trimmed.startsWith("<local-command") ||
    trimmed.startsWith("<user-memory") ||
    trimmed.startsWith("<system-reminder") ||
    trimmed.startsWith("[Request interrupted") ||
    trimmed.startsWith("This is your task:")
  );
}

function claudeToolResultText(result: JsonObject): string {
  if (typeof result.content === "string") return result.content;
  if (!Array.isArray(result.content)) return "";
  return result.content
    .map((block) => {
      const textBlock = asObject(block);
      return textBlock && typeof textBlock.text === "string" ? textBlock.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function claudeToolResultExitCode(result: JsonObject): number | null {
  const match = claudeToolResultText(result).match(/exit\s*code\s*[:=]?\s*(-?\d+)/i);
  return match ? Number(match[1]) : null;
}
