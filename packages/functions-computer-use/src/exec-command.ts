// Exec command orchestration (C4): reads the script ONCE and routes the
// fixed code string through the session host, which owns deduplication. The
// worker never re-reads the (possibly changed) source file.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sendRequest } from "@ya-skills/computer-session";
import { resolveSessionTarget } from "./session-command.js";
import { jsonError, stringifyJson } from "./output.js";

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
      return stringifyJson({ schemaVersion: 1, session: request.sessionId, result: reply.result ?? null });
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
