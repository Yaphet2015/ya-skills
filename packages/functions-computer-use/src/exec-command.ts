// Exec command orchestration (C4): reads the script ONCE, hashes the
// content, and routes the fixed code string through the session host. The
// worker never re-reads the (possibly changed) source file.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sendRequest } from "@ya-skills/computer-session";
import { canonicalRequestHash } from "@ya-skills/computer-runtime";
import { resolveSessionTarget } from "./session-command.js";

function jsonError(code: string, message: string, extra: Record<string, unknown> = {}): Error {
  return new Error(JSON.stringify({ error: { code, message, ...extra } }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

export interface ExecCommandRequest {
  sessionId: string;
  file: string;
  requestId: string;
  timeoutMs?: number;
  maxActions?: number;
}

export function execCommand(): (request: ExecCommandRequest) => Promise<string> {
  return async (request) => {
    let code: string;
    try {
      code = await readFile(request.file, "utf8");
    } catch (error) {
      throw jsonError("script_unreadable", `${request.file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const session = await resolveSessionTarget(request.sessionId);
    const operation = {
      kind: "exec" as const,
      code,
      // The session host runs from a private worker cwd. Capture an
      // absolute source path so the worker's documented script cwd remains
      // the directory containing the file supplied by the caller.
      sourceName: resolve(request.file),
      timeoutMs: request.timeoutMs ?? 60_000,
      maxActions: request.maxActions ?? 100
    };
    // Content hash for dedup — captured at read time, never re-read.
    void canonicalRequestHash({ kind: "exec", target: { pid: 0, windowId: "0" }, operation });
    const timeout = operation.timeoutMs + 30_000;
    const reply = await sendRequest(
      session.socketPath,
      {
        schemaVersion: 1,
        sessionId: request.sessionId,
        generation: session.generation,
        requestId: request.requestId,
        operation
      },
      timeout
    );
    if (reply.status === "completed") {
      return JSON.stringify(
        { schemaVersion: 1, session: request.sessionId, result: reply.result ?? null },
        (_k, v) => (typeof v === "bigint" ? v.toString() : v)
      );
    }
    throw jsonError(
      reply.status === "unknown" ? "unknown_delivery" : reply.error?.code ?? "exec_failed",
      reply.error?.message ?? `exec ended ${reply.status}`,
      {
        sessionRequestId: request.requestId,
        status: reply.status,
        ...(reply.error !== undefined ? { executionError: reply.error } : {}),
        // Failure receipts are the recovery record: delivered input is not
        // undone and an unknown result must never be hidden behind a generic
        // CLI error.
        ...(reply.result !== undefined ? { result: reply.result } : {})
      }
    );
  };
}
