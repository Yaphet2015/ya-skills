// Session command orchestration (B4): open/status/cancel/close plus the
// --session routing for observe/batch/act. All desktop work happens in the
// dedicated host process; this module only parses, connects, and prints.

import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  findSession,
  openSession,
  sendControl,
  sendRequest,
  validateSessionId,
  type OpenedSession
} from "@ya-skills/computer-session";
import { createComputerSession, selectWindow, type ComputerSession, type Target } from "@ya-skills/computer-runtime";

export const SESSION_USAGE = `usage: yk computer-use session <open|status|cancel|close>
  open   --pid P [--window ID] [--idle-timeout-ms N (<=120000)]
  status --session ID
  cancel --session ID --request-id REQUEST
  close  --session ID`;

function jsonError(code: string, message: string, extra: Record<string, unknown> = {}): Error {
  return new Error(JSON.stringify({ error: { code, message, ...extra } }));
}

const replacer = (_key: string, value: unknown) => (typeof value === "bigint" ? value.toString() : value);

export interface SessionSubcommand {
  sub: "open" | "status" | "cancel" | "close";
  pid?: number;
  windowId?: bigint;
  sessionId?: string;
  requestId?: string;
  idleTimeoutMs?: number;
}

export function parseSessionArgs(argv: string[]): SessionSubcommand {
  const [sub, ...rest] = argv;
  if (sub !== "open" && sub !== "status" && sub !== "cancel" && sub !== "close") {
    throw new Error(`session needs a subcommand (open|status|cancel|close)\n${SESSION_USAGE}`);
  }
  const values: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (!flag.startsWith("--")) throw new Error(`unexpected positional: ${flag}\n${SESSION_USAGE}`);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`${flag} requires a value`);
    const key = flag.slice(2);
    if (values[key] !== undefined) throw new Error(`${flag} given twice`);
    values[key] = next;
    i++;
  }
  const allowed = new Set(["pid", "window", "session", "request-id", "idle-timeout-ms"]);
  for (const key of Object.keys(values)) {
    if (!allowed.has(key)) throw new Error(`unknown flag --${key}\n${SESSION_USAGE}`);
  }
  if (sub === "open") {
    if (values.session !== undefined) throw new Error("--session and --pid are exclusive\n" + SESSION_USAGE);
    if (!/^\d+$/.test(values.pid ?? "")) throw new Error("session open requires a positive --pid");
    const parsedPid = Number(values.pid);
    if (!Number.isSafeInteger(parsedPid) || parsedPid <= 0) throw new Error("session open requires a positive safe --pid");
    if (values.window !== undefined && !/^\d+$/.test(values.window)) {
      throw new Error("--window must be decimal digits");
    }
    let idleTimeoutMs = 120_000;
    if (values["idle-timeout-ms"] !== undefined) {
      if (!/^\d+$/.test(values["idle-timeout-ms"])) throw new Error("--idle-timeout-ms must be a positive integer");
      idleTimeoutMs = Number(values["idle-timeout-ms"]);
      if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs <= 0) throw new Error("--idle-timeout-ms must be a positive safe integer");
      if (idleTimeoutMs > 120_000) throw new Error("--idle-timeout-ms must be <= 120000");
    }
    return {
      sub,
      pid: parsedPid,
      ...(values.window !== undefined ? { windowId: BigInt(values.window) } : {}),
      idleTimeoutMs
    };
  }
  if (values.session === undefined) throw new Error(`session ${sub} requires --session ID`);
  if (sub === "cancel" && values["request-id"] === undefined) {
    throw new Error("session cancel requires --request-id REQUEST");
  }
  if (values["request-id"] !== undefined && !/^[A-Za-z0-9._-]{1,128}$/.test(values["request-id"])) {
    throw new Error("--request-id must contain only letters, numbers, dot, underscore, or hyphen (max 128 characters)");
  }
  validateSessionId(values.session);
  return { sub, sessionId: values.session, ...(values["request-id"] !== undefined ? { requestId: values["request-id"] } : {}) };
}

export function sessionCommand(
  deps: {
    open?: (options: {
      target: { pid: number; windowId: bigint };
      idleTimeoutMs: number;
    }) => Promise<OpenedSession>;
    /** Read-only resolver used when `session open` omits --window. */
    resolveWindow?: (pid: number) => Promise<{ pid: number; windowId: bigint }>;
  } = {}
): (sub: SessionSubcommand) => Promise<string> {
  const doOpen =
    deps.open ??
    (async (options: { target: { pid: number; windowId: bigint }; idleTimeoutMs: number }) =>
      openSession(options));
  const resolveWindow = deps.resolveWindow ?? (async (pid: number): Promise<Target> => {
    const session: ComputerSession = createComputerSession();
    try {
      const window = selectWindow(await session.computer.windows(pid));
      return { pid, windowId: window.windowId };
    } finally {
      await session.close().catch(() => undefined);
    }
  });
  return async (sub) => {
    switch (sub.sub) {
      case "open": {
        const target =
          sub.windowId === undefined
            ? await resolveWindow(sub.pid!)
            : { pid: sub.pid!, windowId: sub.windowId };
        const opened = await doOpen({
          target,
          idleTimeoutMs: sub.idleTimeoutMs ?? 120_000
        });
        return JSON.stringify({ schemaVersion: 1, session: opened.info }, replacer);
      }
      case "status": {
        const found = await findSession(sub.sessionId!);
        if (!found) throw jsonError("unknown_session", `no session ${sub.sessionId} — open one first`);
        // A confirmed closed session removes its socket but retains metadata;
        // status remains useful and does not turn idempotent cleanup into an
        // ENOENT error.
        if (found.info.state === "closed") {
          return JSON.stringify({ schemaVersion: 1, session: found.info }, replacer);
        }
        if (found.info.state === "unusable" && !existsSync(found.socketPath)) {
          return JSON.stringify({ schemaVersion: 1, session: found.info, cleanup: { leaseRetained: true, hostUnavailable: true } }, replacer);
        }
        const reply = await sendControl(found.socketPath, { kind: "status", schemaVersion: 1, sessionId: sub.sessionId! }, 5_000);
        if (reply.error) throw jsonError(reply.error.code, reply.error.message);
        return JSON.stringify({ schemaVersion: 1, session: reply.info }, replacer);
      }
      case "cancel": {
        const found = await findSession(sub.sessionId!);
        if (!found) throw jsonError("unknown_session", `no session ${sub.sessionId}`);
        const reply = await sendControl(
          found.socketPath,
          { kind: "cancel", schemaVersion: 1, sessionId: sub.sessionId!, requestId: sub.requestId! },
          5_000
        );
        if (reply.error) throw jsonError(reply.error.code, reply.error.message);
        return JSON.stringify(
          {
            schemaVersion: 1,
            session: reply.info,
            next: "the cancelled request's delivery state is recorded; observe instead of replaying"
          },
          replacer
        );
      }
      case "close": {
        const found = await findSession(sub.sessionId!);
        if (!found) throw jsonError("unknown_session", `no session ${sub.sessionId}`);
        if (found.info.state === "closed") {
          return JSON.stringify({ schemaVersion: 1, session: found.info, cleanup: { alreadyClosed: true } }, replacer);
        }
        if (found.info.state === "unusable" && !existsSync(found.socketPath)) {
          return JSON.stringify({ schemaVersion: 1, session: found.info, cleanup: { leaseRetained: true, hostUnavailable: true } }, replacer);
        }
        const reply = await sendControl(found.socketPath, { kind: "close", schemaVersion: 1, sessionId: sub.sessionId! }, 15_000);
        if (reply.error) throw jsonError(reply.error.code, reply.error.message);
        return JSON.stringify({ schemaVersion: 1, session: reply.info, ...("cleanup" in reply ? { cleanup: (reply as unknown as { cleanup: unknown }).cleanup } : {}) }, replacer);
      }
    }
  };
}

/** Resolve the socket + generation for a `--session ID` business command. */
export async function resolveSessionTarget(sessionId: string): Promise<{
  socketPath: string;
  generation: string;
  info: { target: { pid: number; windowId: string } };
}> {
  const found = await findSession(sessionId);
  if (!found) {
    throw jsonError("unknown_session", `no session ${sessionId} — open one with: yk computer-use session open --pid P [--window W]`);
  }
  return { socketPath: found.socketPath, generation: found.info.generation, info: { target: found.info.target } };
}

/** Run a business operation through a session host. */
export async function runOnSession(
  sessionId: string,
  operation:
    | { kind: "observe"; options?: unknown }
    | { kind: "batch"; request: unknown; file?: string; requestId?: string },
  timeoutMs = 30_000
): Promise<string> {
  const session = await resolveSessionTarget(sessionId);
  const requestId =
    operation.kind === "batch"
      ? (operation.requestId ?? throwMissingRequestId())
      : `observe-${randomUUID()}`;
  const reply = await sendRequest(
    session.socketPath,
    {
      schemaVersion: 1,
      sessionId,
      generation: session.generation,
      requestId,
      operation: operation as never
    },
    timeoutMs
  );
  if (reply.status === "completed") {
    return JSON.stringify({ schemaVersion: 1, session: sessionId, result: reply.result ?? null }, replacer);
  }
  throw jsonError(
    reply.status === "unknown" ? "unknown_delivery" : reply.error?.code ?? "session_failed",
    reply.error?.message ?? `session request ended ${reply.status}`,
    { sessionRequestId: requestId, reply }
  );
}

function throwMissingRequestId(): never {
  throw jsonError("missing_request_id", "batch on a session requires --request-id");
}
