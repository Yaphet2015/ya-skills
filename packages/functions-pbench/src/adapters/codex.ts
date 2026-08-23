import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { asObject, commandVersion, findSessionFileByName, isErrorRecord, parseJsonlLines, valueToText } from "./shared.js";
import type { AgentRunner, JsonObject, NormalizedSession, SessionSource } from "./types.js";

export function createCodexSessionSource(): SessionSource {
  return {
    id: "codex",
    sourceKind: "codex-session",
    locate: locateCodexSession,
    extract: (rawText) => extractCodexSession(parseJsonlLines(rawText))
  };
}

export function createCodexAgentRunner(): AgentRunner {
  return {
    id: "codex",
    defaultIsolation: "workspace-write",
    launch: ({ worktree, prompt, env, timeoutMs }) => {
      const result = spawnSync(
        "codex",
        ["--ask-for-approval", "never", "exec", "--json", "--ephemeral", "--cd", worktree, "--sandbox", "workspace-write", "-"],
        { cwd: worktree, input: prompt, encoding: "utf8", env, timeout: timeoutMs }
      );
      return {
        exitCode: result.status ?? (result.signal ? 124 : null),
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? ""
      };
    },
    parseSummary: parseCodexJsonlSummary,
    versionProbe: (env) => commandVersion("codex", env)
  };
}

async function locateCodexSession(options: { sessionId?: string; home: string }): Promise<string> {
  if (!options.sessionId) {
    throw new Error(
      "Pass --session-id <id> or --input <jsonl> to identify which Codex session to capture; the session index does not record file paths or working directories."
    );
  }
  const path = await findSessionFileByName(join(options.home, ".codex", "sessions"), options.sessionId);
  if (!path) {
    throw new Error(
      `No Codex session file found for session id "${options.sessionId}". Pass --input <jsonl> to capture it directly.`
    );
  }
  return path;
}

function extractCodexSession(records: JsonObject[]): NormalizedSession {
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
    if (role === "user" && content && !isInjectedUserContext(content)) userMessages.push(content);
    if (role === "assistant" && content) assistantMessages.push(content);

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
        if (outputText) target.stdout = [String(target.stdout ?? ""), outputText].filter(Boolean).join("\n");
        const exitCode = parseProcessExitCode(outputText);
        if (exitCode !== null) {
          target.exit_code = exitCode;
          target.status = exitCode === 0 ? "success" : "failed";
        }
        if (isErrorRecord(target) && !errorRecords.includes(target)) errorRecords.push(target);
      }
    }
    if (isErrorRecord(normalized)) errorRecords.push(normalized);
    if (isApprovalSandboxRecord(normalized)) approvalSandboxRecords.push(normalized);
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
  return record ? asObject(record.payload) ?? record : {};
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
  if (body.input !== undefined) normalized.input = body.input;
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
  const args = asObject(record.arguments) ?? {};
  const command = String(args.cmd ?? args.command ?? record.command ?? "");
  const text = [String(record.input ?? ""), command].join("\n");
  for (const match of text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
    touched.add(match[1].trim());
  }
}

function isApprovalSandboxRecord(record: JsonObject): boolean {
  const serialized = JSON.stringify(record).toLowerCase();
  return serialized.includes("approval") || serialized.includes("sandbox");
}

function parseCodexJsonlSummary(stdoutText: string) {
  let lastMessage: string | null = null;
  let tokenUsage: JsonObject | null = null;
  for (const line of stdoutText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as JsonObject;
      const payload = asObject(record.payload);
      const usage = asObject(record.usage) ?? asObject(payload?.usage);
      if (usage) tokenUsage = usage;
      const text = valueToText(record.content ?? payload?.content);
      if (text) lastMessage = text;
    } catch {
      // Raw output remains available to the caller.
    }
  }
  return { lastMessage, tokenUsage };
}
