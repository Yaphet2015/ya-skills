// Exec worker (C1/C2): one disposable subprocess per exec request. Runs the
// captured JS string (an async-function body, NOT an ES module) with the
// fixed facade; every desktop operation is an RPC to the host over the
// CONTROL channel (fd4). stdout/stderr are plain LOGS. Logs are bounded; the
// worker never decides its own success — the host does.
//
// Static imports are rejected by SYNTAX validation (P2.2): an async-function
// body is script-scoped, so `import x from "y"` is a SyntaxError while
// dynamic `import()` stays a legal expression — no fragile text regex.

import { readFile } from "node:fs/promises";
import { writeSync } from "node:fs";
import { ComputerError } from "@ya-skills/computer-runtime";
import { createScriptComputer } from "./script-computer.js";
import { deepRestoreWindowIds, MAX_MESSAGE_BYTES } from "./protocol.js";
import {
  EXEC_MAX_CODE_BYTES,
  EXEC_MAX_LOG_BYTES,
  type JsonValue,
  type ScriptRpcReply,
  type ScriptRpcRequest
} from "./exec-types.js";

/** Worker-side cap on RPCs sent but unanswered (F16). */
const EXEC_OUTSTANDING_RPC_LIMIT = 64;

export interface ExecWorkerConfig {
  schemaVersion: 1;
  sessionId: string;
  requestId: string;
  generation: string;
  /** The session's bound target (P2.1): scripts see the REAL app, never a
   * placeholder pid 0. */
  target: { pid: number; windowId: string };
  code: string;
  sourceName: string;
  timeoutMs: number;
  maxActions: number;
  /** State SNAPSHOT for this run (the host owns commits). */
  state: Record<string, JsonValue>;
  /** Working directory for the script (its source file's directory). */
  cwd: string;
}

interface HostMessage {
  type: "exec_boot_ok";
}

/** Control frames (protocol) go to fd3 — the dedicated control pipe — while
 * logs go to stdout/stderr; the two channels never mix (F16). */
function sendControl(value: unknown): void {
  writeSync(3, `${JSON.stringify(value)}\n`);
}

function logOut(value: string): void {
  process.stdout.write(`${value}\n`);
}

export async function execWorkerMain(configPath: string): Promise<number> {
  const config = JSON.parse(await readFile(configPath, "utf8")) as ExecWorkerConfig;
  if (typeof config.code !== "string") {
    sendControl({ type: "exec_failed", error: { code: "invalid_code", message: "code must be a string" } });
    return 2;
  }
  if (Buffer.byteLength(config.code, "utf8") > EXEC_MAX_CODE_BYTES) {
    sendControl({ type: "exec_failed", error: { code: "code_too_large", message: `code exceeds ${EXEC_MAX_CODE_BYTES} bytes` } });
    return 2;
  }
  // Compile FIRST: static-import statements (and every other syntax error)
  // are rejected before ANY log hook or RPC surface exists.
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  let execute: (...args: unknown[]) => Promise<unknown>;
  try {
    execute = new AsyncFunction("computer", "target", "state", "log", "observe", config.code) as never;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendControl({
      type: "exec_failed",
      error: {
        code: /import/i.test(message) ? "static_import" : "invalid_syntax",
        message:
          /import/i.test(message)
            ? `static import syntax is not valid in an async-function body — use dynamic import() with absolute file: URLs (${message})`
            : `the script body does not compile (${message})`
      }
    });
    return 2;
  }

  // The script's working directory is its source file's directory (C1/P2.1).
  // The worker booted in a private dir; chdir AFTER config load so no project
  // preload ever ran in the script's cwd.
  try {
    process.chdir(config.cwd);
  } catch {
    sendControl({
      type: "exec_failed",
      error: { code: "invalid_cwd", message: `the script working directory does not exist: ${config.cwd}` }
    });
    return 2;
  }

  // Bounded log capture: console.* joins log() lines; over-budget closes
  // admission immediately. User code may catch a rejected facade call, so
  // the worker sends one terminal frame as soon as the boundary is crossed.
  let logBytes = 0;
  const logs: string[] = [];
  let logOverflow = false;
  let terminalSent = false;
  const failWorker = (code: string, message: string): void => {
    if (terminalSent) return;
    terminalSent = true;
    try {
      sendControl({ type: "exec_failed", error: { code, message }, logs });
    } catch {
      // The host is already gone; its process-group cleanup is authoritative.
    }
  };
  const pushLog = (line: string): void => {
    if (logOverflow) return;
    const encoded = Buffer.byteLength(line, "utf8") + 1;
    if (logBytes + encoded > EXEC_MAX_LOG_BYTES) {
      logOverflow = true;
      logs.push(`[output_limit: log budget ${EXEC_MAX_LOG_BYTES} bytes exceeded — script cancelled]`);
      failWorker("output_limit", "log budget exceeded");
      return;
    }
    logBytes += encoded;
    logs.push(line);
  };
  const emitLog = (value: unknown): void => {
    if (typeof value === "string") pushLog(value);
    else {
      try {
        const encoded = JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
        pushLog(encoded === undefined ? String(value) : encoded);
      } catch {
        pushLog(String(value));
      }
    }
    // console-style output ALSO lands on the log channel (stdout) for the
    // host's bounded capture; log() itself stays protocol-free.
    let output = value as unknown as string;
    if (typeof value !== "string") {
      try {
        const encoded = JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
        output = encoded === undefined ? String(value) : encoded;
      } catch {
        output = String(value);
      }
    }
    logOut(output);
  };
  console.log = (...args: unknown[]) => {
    emitLog(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    emitLog(args.map(String).join(" "));
  };
  console.warn = (...args: unknown[]) => {
    emitLog(args.map(String).join(" "));
  };

  // RPC plumbing: worker-initiated fixed-method calls over the CONTROL
  // channel (fd4). Outstanding calls are bounded (F16): a runaway fan-out
  // fails immediately instead of queueing without limit.
  let nextSeq = 1;
  const waiters = new Map<number, { resolve: (v: JsonValue) => void; reject: (e: unknown) => void }>();
  const pending = new Set<number>();
  const call = async (method: ScriptRpcRequest["method"], args: Record<string, JsonValue>): Promise<JsonValue> => {
    if (terminalSent) {
      throw new ComputerError("exec_finished", "the exec request is no longer accepting calls");
    }
    if (pending.size >= EXEC_OUTSTANDING_RPC_LIMIT) {
      failWorker(
        "rpc_queue_overflow",
        `more than ${EXEC_OUTSTANDING_RPC_LIMIT} facade calls are in flight — await them before issuing more`
      );
      throw new ComputerError(
        "rpc_queue_overflow",
        `more than ${EXEC_OUTSTANDING_RPC_LIMIT} facade calls are in flight — await them before issuing more`
      );
    }
    const seq = nextSeq++;
    const promise = new Promise<JsonValue>((resolve, reject) => {
      waiters.set(seq, { resolve, reject });
    });
    pending.add(seq);
    sendControl({ type: "rpc", seq, method, args });
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => {
        const message = `host did not answer rpc ${seq} (${method})`;
        failWorker("rpc_timeout", message);
        reject(new ComputerError("rpc_timeout", message));
      }, Math.max(config.timeoutMs, 5_000));
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      pending.delete(seq);
      waiters.delete(seq);
    }
  };
  // Control replies arrive on STDIN (the host writes them there); parse
  // newline frames with a streaming UTF-8 decoder (F17).
  let controlBuffer = "";
  let controlFrameBytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const readControlChunk = (chunk: Buffer): void => {
    for (const byte of chunk) {
      if (byte === 0x0a) controlFrameBytes = 0;
      else if (++controlFrameBytes > MAX_MESSAGE_BYTES) {
        failWorker("protocol_message_too_large", `control frame exceeds ${MAX_MESSAGE_BYTES} bytes`);
        return;
      }
    }
    try {
      controlBuffer += decoder.decode(chunk, { stream: true });
    } catch {
      failWorker("protocol_utf8", "control data is not valid UTF-8");
      return;
    }
    for (;;) {
      const newline = controlBuffer.indexOf("\n");
      if (newline === -1) break;
      const line = controlBuffer.slice(0, newline);
      controlBuffer = controlBuffer.slice(newline + 1);
      if (line.trim() === "") continue;
      let message: HostMessage | ScriptRpcReply;
      try {
        message = JSON.parse(line) as HostMessage | ScriptRpcReply;
      } catch {
        continue;
      }
      if ("seq" in message) {
        const waiter = waiters.get(message.seq);
        if (waiter) {
          if (message.ok) waiter.resolve(deepRestoreWindowIds(message.result) as JsonValue);
          else {
            const error = message.error as { code?: string; message?: string };
            waiter.reject(new ComputerError(error?.code ?? "host_rpc_failed", error?.message ?? "rpc failed"));
          }
        }
      }
    }
  };
  let stdinClosed = false;
  process.stdin.on("data", (chunk: Buffer) => readControlChunk(chunk));
  process.stdin.on("close", () => {
    stdinClosed = true;
    const error = new ComputerError("host_gone", "the session host is gone");
    for (const waiter of waiters.values()) waiter.reject(error);
  });
  process.stdin.resume();

  const computer = createScriptComputer(call);
  const state = config.state;
  const target = Object.freeze({ pid: config.target.pid, windowId: BigInt(config.target.windowId) });

  sendControl({ type: "exec_started", sourceName: config.sourceName });

  let value: unknown;
  try {
    value = await execute(computer, target, state, emitLog, computer.observe.bind(computer));
  } catch (error) {
    if (terminalSent) return 1;
    sendControl({
      type: "exec_failed",
      error: {
        code: error instanceof ComputerError ? error.code : "script_error",
        message: error instanceof Error ? error.message : String(error)
      },
      logs
    });
    return 1;
  }
  if (terminalSent || logOverflow) {
    if (!terminalSent) failWorker("output_limit", "log budget exceeded");
    return 1;
  }
  // Unawaited RPCs still in flight: refuse to claim completion.
  if (pending.size > 0) {
    sendControl({
      type: "exec_unawaited",
      pendingSeqs: [...pending],
      logs
    });
    return 1;
  }
  if (stdinClosed) {
    sendControl({ type: "exec_failed", error: { code: "host_gone", message: "host connection lost" }, logs });
    return 1;
  }
  // The wire is JSON: validate BEFORE serializing so class instances
  // (Date, Map, ...) are refused here instead of silently degrading to
  // strings/objects on their way to the host.
  try {
    const { validateJsonValue } = await import("./exec-state.js");
    validateJsonValue(state, 256 * 1024);
    validateJsonValue(value ?? null, 256 * 1024);
  } catch (error) {
    sendControl({
      type: "exec_failed",
      error: { code: "state_invalid", message: error instanceof Error ? error.message : String(error) },
      logs
    });
    return 1;
  }
  sendControl({
    type: "exec_done",
    value: (value ?? null) as JsonValue,
    state: state as JsonValue,
    logs
  });
  return 0;
}
