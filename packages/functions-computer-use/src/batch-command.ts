// Batch command orchestration: the JSON file is read and hashed BEFORE any
// driver exists; the RequestJournal dedupes by request-id + content hash so a
// retry of the same request replays nothing. failed/interrupted results are
// returned as errors (non-zero exit) while receipts stay visible.

import { homedir } from "node:os";
import { sessionRoot } from "@ya-skills/computer-session";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import {
  bigintSafeReplacer,
  canonicalRequestHash,
  ComputerError,
  DEFAULT_BATCH_TIMEOUT_MS,
  MAX_BATCH_TIMEOUT_MS,
  createComputerSession,
  createRequestJournal,
  createAutoLeases,
  createObservationStore,
  defaultArtifactsDir,
  selectWindow,
  validateBatch,
  type ActionReceipt,
  type BatchRequest,
  type ComputerSession,
  type RequestJournal,
  type RequestRecord,
  type Target
} from "@ya-skills/computer-runtime";

export function defaultRequestsDir(): string {
  return join(homedir(), "Library", "Caches", "ya-skills", "computer-use", "requests");
}

export interface BatchCommandRequest {
  pid: number;
  windowId?: bigint;
  file: string;
  requestId: string;
  outDir?: string;
  /** CLI budget overrides applied on top of the file's request. */
  timeoutMs?: number;
  maxActions?: number;
}

function jsonError(code: string, message: string, extra: Record<string, unknown> = {}): Error {
  return new Error(JSON.stringify({ error: { code, message, ...extra } }, bigintSafeReplacer));
}

function encodeResult(target: Target, result: unknown): string {
  return JSON.stringify({ schemaVersion: 1, target, result }, bigintSafeReplacer);
}

export function batchCommand(
  deps: {
    createSession?: (options: { deadlineAt: number; artifactsDir?: string }) => ComputerSession;
    requestsDir?: string;
    /** Test seam for persistence latency; production always uses requestsDir. */
    journal?: RequestJournal;
  } = {}
): (request: BatchCommandRequest) => Promise<string> {
  const leaseSet = createAutoLeases(sessionRoot(), "single-step");
  const createSession =
    deps.createSession ??
    ((options: { deadlineAt: number; artifactsDir?: string }) => {
      const artifactsDir = options.artifactsDir ?? defaultArtifactsDir();
      return createComputerSession({
        ...options,
        artifactsDir,
        observationStore: createObservationStore(join(artifactsDir, "observations")),
        leases: leaseSet
      });
    });
  const requestsDir = deps.requestsDir ?? defaultRequestsDir();
  return async (request) => {
    const platform = process.platform === "darwin" && process.arch === "arm64";
    if (!platform) {
      throw jsonError(
        "unsupported_platform",
        `computer-use requires macOS arm64 (this machine: ${process.platform} ${process.arch})`
      );
    }
    // 1. Read + validate the batch file BEFORE any driver work; the content
    //    hash fixes the request for dedup regardless of later file edits.
    let raw: string;
    try {
      raw = await readFile(request.file, "utf8");
    } catch (error) {
      throw jsonError("batch_file_unreadable", `${request.file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw jsonError("batch_file_invalid_json", `${request.file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    // CLI budget overrides (validated in args.ts) apply ON TOP of the file
    // content; they participate in the dedup hash because they change what
    // runs.
    if (request.timeoutMs !== undefined || request.maxActions !== undefined) {
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw jsonError("batch_request_invalid", "batch file must contain a JSON object to apply budget overrides");
      }
      parsed = {
        ...(parsed as Record<string, unknown>),
        ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
        ...(request.maxActions !== undefined ? { maxActions: request.maxActions } : {})
      };
    }
    let batchRequest: BatchRequest;
    try {
      batchRequest = validateBatch(parsed);
    } catch (error) {
      throw jsonError("batch_request_invalid", error instanceof Error ? error.message : String(error));
    }

    // 2. Dedup: same id + same content returns the recorded outcome without
    //    re-running anything; same id + different content is a conflict.
    // Start one absolute budget before journal claim/start persistence. The
    // same deadline is passed to the session and recomputed before every
    // per-action dispatch and final observation; it is never reset by a
    // one-action runtime batch.
    const deadlineAt = Date.now() + (batchRequest.timeoutMs ?? DEFAULT_BATCH_TIMEOUT_MS);
    const journal = deps.journal ?? createRequestJournal(requestsDir);
    const hash = canonicalRequestHash({
      kind: "batch",
      target: { pid: request.pid, windowId: request.windowId ?? 0n },
      operation: parsed
    });
    const claim = await journal.claim(request.requestId, hash);
    if (claim === "existing") {
      const record: RequestRecord = await journal.read(request.requestId);
      const finished = record.events.find((e) => e.type === "request_finished");
      if (finished?.payload.status !== undefined) {
        const result = finished.payload.result ?? {
          status: record.status,
          steps: [],
          note: "prior run finished without a detailed result — check events.jsonl"
        };
        if (record.status === "completed") {
          return encodeResult({ pid: request.pid, windowId: request.windowId ?? 0n }, result);
        }
        throw jsonError("batch_not_replayed", `request ${request.requestId} already ran with status ${record.status}; delivery state is unknown in part — observe instead of replaying`, {
          priorStatus: record.status,
          result
        });
      }
      throw jsonError("batch_in_progress", `request ${request.requestId} is already running (or its writer died mid-run; status reads ${record.status}) — observe the current state instead of replaying`);
    }
    if (claim === "conflict") {
      throw jsonError("request_conflict", `request-id ${request.requestId} was already used with DIFFERENT content — use a new request-id`);
    }

    // 3. Execute once. Every event append is awaited; a desktop dispatch
    // cannot begin until its durable start event exists, and a terminal reply
    // is not returned while its outcome is still only in memory.
    let nextSeq = 0;
    const appendEvent = async (
      type: "request_started" | "action_started" | "action_finished" | "request_finished",
      payload: Record<string, unknown>
    ): Promise<void> => {
      const seq = nextSeq;
      await journal.append(request.requestId, { seq, time: Date.now(), type, payload });
      nextSeq++;
    };
    try {
      await appendEvent("request_started", {
        kind: "batch",
        file: request.file,
        actions: batchRequest.actions.length
      });
    } catch (error) {
      throw jsonError(
        "journal_error",
        `could not persist batch start — nothing was dispatched: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    const session = createSession({
      // The request budget, rather than the one-shot command's fixed 30s
      // startup cap, governs this whole standalone batch. Runtime operations
      // still apply their own per-operation ceiling to each native call.
      deadlineAt,
      ...(request.outDir !== undefined ? { artifactsDir: request.outDir } : {})
    });
    let target: Target | undefined;
    let result: import("@ya-skills/computer-runtime").BatchResult | undefined;
    const finished = new Set<number>();
    let terminalWritten = false;
    try {
      const win = selectWindow(await session.computer.windows(request.pid), request.windowId);
      target = { pid: request.pid, windowId: win.windowId };
      const steps: import("@ya-skills/computer-runtime").ActionReceipt[] = [];
      const fillNotRun = async (from: number, error?: { code: string; message: string }): Promise<void> => {
        for (let index = from; index < batchRequest.actions.length; index++) {
          const action = batchRequest.actions[index]!;
          const receipt = { index, kind: action.kind, status: "not_run" as const, ...(error !== undefined ? { error } : {}) };
          steps[index] = receipt;
          await appendEvent("action_finished", {
            index,
            kind: action.kind,
            outcome: receipt.status,
            ...(error !== undefined ? { error } : {})
          });
          finished.add(index);
        }
      };
      let status: import("@ya-skills/computer-runtime").BatchResult["status"] = "completed";
      for (const [index, action] of batchRequest.actions.entries()) {
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) {
          const error = { code: "batch_deadline", message: "batch timeout budget exhausted before dispatch" };
          steps[index] = { index, kind: action.kind, status: "not_run", error };
          await appendEvent("action_finished", { index, kind: action.kind, outcome: "not_run", error });
          finished.add(index);
          await fillNotRun(index + 1);
          status = "interrupted";
          break;
        }
        await appendEvent("action_started", { index, kind: action.kind });
        // Persisting action_started is part of the same absolute budget. Do
        // not dispatch with the duration measured before that await.
        const dispatchRemaining = deadlineAt - Date.now();
        if (dispatchRemaining <= 0) {
          const error = { code: "batch_deadline", message: "batch timeout budget exhausted before dispatch" };
          steps[index] = { index, kind: action.kind, status: "not_run", error };
          await appendEvent("action_finished", { index, kind: action.kind, outcome: "not_run", error });
          finished.add(index);
          await fillNotRun(index + 1);
          status = "interrupted";
          break;
        }
        const one = await session.computer.batch(target, {
          actions: [action],
          // Compute immediately before entering the runtime; the runtime
          // receives the remaining budget, while the session's absolute
          // deadline prevents setup/final evidence from extending it.
          timeoutMs: Math.max(1, Math.min(dispatchRemaining, MAX_BATCH_TIMEOUT_MS)),
          maxActions: 1
        });
        const local = one.steps[0];
        const receipt: import("@ya-skills/computer-runtime").ActionReceipt = {
          ...(local ?? { kind: action.kind, status: "unknown" as const }),
          index,
          kind: action.kind,
          status: local?.status ?? "unknown"
        };
        steps[index] = receipt;
        await appendEvent("action_finished", {
          index,
          kind: action.kind,
          outcome: receipt.status,
          ...(receipt.error !== undefined ? { error: receipt.error } : {})
        });
        finished.add(index);
        if (receipt.status !== "delivered" && receipt.status !== "satisfied") {
          await fillNotRun(index + 1);
          status = receipt.status === "unknown" || one.status === "interrupted" ? "interrupted" : "failed";
          break;
        }
      }
      if (status === "completed" && batchRequest.observe !== undefined) {
        const finalRemaining = deadlineAt - Date.now();
        if (finalRemaining <= 0) {
          result = {
            status: "interrupted",
            steps,
            observationError: {
              code: "batch_deadline",
              message: "batch timeout budget exhausted before final observation"
            }
          };
        } else {
          try {
            // SessionOptions carries the same absolute deadline, so this read
            // cannot restart the budget after the last action. Re-check after
            // it resolves too: a native observer may return a successful frame
            // only after the absolute command budget has expired.
            const observation = await session.computer.observe(target, batchRequest.observe);
            if (Date.now() >= deadlineAt) {
              result = {
                status: "interrupted",
                steps,
                observationError: {
                  code: "batch_deadline",
                  message: "batch timeout budget exhausted during final observation"
                }
              };
            } else {
              result = { status, steps, observation };
            }
          } catch (error) {
            const interrupted =
              Date.now() >= deadlineAt ||
              (error instanceof ComputerError &&
                (error.code === "command_timeout" || error.code === "aborted" || error.code === "request_cancelled"));
            result = {
              status: interrupted ? "interrupted" : status,
              steps,
              observationError: {
                code: error instanceof ComputerError ? error.code : "final_observe_failed",
                message: error instanceof Error ? error.message : String(error)
              }
            };
          }
        }
      } else {
        result = { status, steps };
      }
      await appendEvent("request_finished", {
        status: result.status,
        result: JSON.parse(JSON.stringify(result, bigintSafeReplacer))
      });
      terminalWritten = true;
      if (result.status === "completed") {
        return encodeResult(target, result);
      }
      throw jsonError(
        result.status === "interrupted" ? "batch_interrupted" : "batch_failed",
        `batch ended ${result.status}: ${result.steps.map((s) => `${s.index}:${s.kind}:${s.status}`).join(", ")}`,
        { result: JSON.parse(JSON.stringify(result, bigintSafeReplacer)) }
      );
    } catch (error) {
      // If dispatch threw before receipts came back, every planned action is
      // conservatively unknown/not-delivered. The terminal event is then
      // written exactly once so retries cannot replay the request.
      if (!terminalWritten) {
        if (target !== undefined) {
          for (const [index, action] of batchRequest.actions.entries()) {
            if (finished.has(index)) continue;
            try {
              await appendEvent("action_finished", {
                index,
                kind: action.kind,
                outcome: "unknown",
                error: { code: "request_failed", message: error instanceof Error ? error.message : String(error) }
              });
              finished.add(index);
            } catch {
              // Failure to record the receipt is itself fail-closed below.
            }
          }
        }
        const terminalStatus = target === undefined ? "failed" : "unknown";
        const partial = result ?? {
          status: terminalStatus === "unknown" ? "interrupted" : "failed",
          steps: batchRequest.actions.map((action, index) => ({
            index,
            kind: action.kind,
            status: terminalStatus === "unknown" ? "unknown" : "not_delivered",
            error: { code: "request_failed", message: error instanceof Error ? error.message : String(error) }
          }))
        };
        try {
          await appendEvent("request_finished", {
            status: terminalStatus,
            result: {
              error: error instanceof Error ? error.message : String(error),
              partial: JSON.parse(JSON.stringify(partial, bigintSafeReplacer))
            }
          });
          terminalWritten = true;
        } catch (journalError) {
          throw jsonError(
            "journal_error",
            `could not persist batch failure; delivery is unknown: ${journalError instanceof Error ? journalError.message : String(journalError)}`,
            { result: JSON.parse(JSON.stringify(partial, bigintSafeReplacer)) }
          );
        }
        if (terminalStatus === "unknown") {
          throw jsonError(
            "batch_unknown",
            error instanceof Error ? error.message : String(error),
            { result: JSON.parse(JSON.stringify(partial, bigintSafeReplacer)) }
          );
        }
      }
      throw error;
    } finally {
      try {
        await session.close();
      } catch (error) {
        console.error("driver cleanup issue:", error instanceof Error ? error.message : error);
      }
    }
  };
}
