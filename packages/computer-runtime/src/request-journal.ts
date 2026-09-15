// Request journal (A5/B3): the single dedup + event-log SSOT for batch and
// exec requests. Same request-id + same content hash returns the existing
// record; same id + different hash is a conflict. Events are JSONL with
// strict per-type payload validation; truncated tails and sequence gaps fail
// loud. An id is claimed atomically via mkdir — a dead writer's
// started-without-finished record is never re-claimed.

import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { processStartTime } from "./target-lease.js";

// Event payloads may embed results whose targets carry bigint windowIds; the
// journal stores them as decimal strings (the same wire convention).
function eventReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export type RequestEventType =
  | "request_started"
  | "action_started"
  | "action_finished"
  | "state_commit_intent"
  | "request_finished";

export interface RequestEvent {
  seq: number;
  time: number;
  type: RequestEventType;
  payload: Record<string, unknown>;
}

export type RequestStatus = "running" | "completed" | "failed" | "interrupted" | "unknown";

export interface RequestRecord {
  hash: string;
  status: RequestStatus;
  events: RequestEvent[];
  result?: unknown;
}

export interface RequestJournal {
  claim(id: string, hash: string): Promise<"new" | "existing" | "conflict">;
  append(id: string, event: RequestEvent): Promise<void>;
  read(id: string): Promise<RequestRecord>;
}

const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

function requestDir(root: string, id: string): string {
  if (!ID_RE.test(id)) {
    throw new Error(`request id must match ${ID_RE} (got: ${id})`);
  }
  return join(root, id);
}

function eventsPath(dir: string): string {
  return join(dir, "events.jsonl");
}

function hashPath(dir: string): string {
  return join(dir, "hash");
}

interface WriterIdentity {
  pid: number;
  processStart?: string;
  time: number;
}

function writerPath(dir: string): string {
  return join(dir, "writer.json");
}

function readWriter(dir: string): WriterIdentity | null {
  try {
    const parsed = JSON.parse(readFileSync(writerPath(dir), "utf8")) as Partial<WriterIdentity>;
    if (
      typeof parsed !== "object" || parsed === null ||
      typeof parsed.pid !== "number" || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0 ||
      typeof parsed.time !== "number" || !Number.isFinite(parsed.time) || parsed.time <= 0 ||
      (parsed.processStart !== undefined && typeof parsed.processStart !== "string")
    ) return null;
    return parsed as WriterIdentity;
  } catch {
    return null;
  }
}

function writerIsDead(writer: WriterIdentity): boolean {
  try {
    process.kill(writer.pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return false;
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function validateEventShape(event: Record<string, unknown>): void {
  if (typeof event.seq !== "number" || !Number.isSafeInteger(event.seq)) {
    throw new Error("journal event .seq must be a safe integer");
  }
  if (typeof event.time !== "number" || !Number.isFinite(event.time) || event.time <= 0) {
    throw new Error("journal event .time must be a positive number");
  }
  switch (event.type) {
    case "request_started":
    case "action_started":
    case "action_finished":
    case "state_commit_intent":
    case "request_finished":
      break;
    default:
      throw new Error(`journal event .type invalid: ${String(event.type)}`);
  }
  if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) {
    throw new Error("journal event .payload must be an object");
  }
}

function parseEvent(line: string, expectedSeq: number): RequestEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`journal event line is not valid JSON (truncated tail?): ${line.slice(0, 120)}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("journal event must be an object");
  }
  validateEventShape(parsed as Record<string, unknown>);
  const event = parsed as unknown as RequestEvent;
  if (event.seq !== expectedSeq) {
    throw new Error(`journal event sequence gap: expected ${expectedSeq}, got ${event.seq}`);
  }
  return event;
}

function readEvents(dir: string): RequestEvent[] {
  const path = eventsPath(dir);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  const effective = lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
  return effective.map((line, i) => parseEvent(line, i));
}

function statusFromEvents(events: RequestEvent[]): RequestStatus {
  if (events.length === 0) return "running";
  const last = events[events.length - 1]!;
  if (last.type === "request_finished") {
    const status = last.payload.status;
    if (status === "completed" || status === "failed" || status === "interrupted" || status === "unknown") {
      return status;
    }
    throw new Error(`request_finished payload.status invalid: ${String(status)}`);
  }
  return "running";
}

export function createRequestJournal(root: string): RequestJournal {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return {
    async claim(id, hash) {
      if (typeof hash !== "string" || hash.length === 0) {
        throw new Error("claim requires a non-empty hash");
      }
      const dir = requestDir(root, id);
      try {
        mkdirSync(dir);
        writeFileSync(hashPath(dir), hash, { mode: 0o600 });
        writeFileSync(
          writerPath(dir),
          JSON.stringify({ pid: process.pid, ...(processStartTime(process.pid) !== undefined ? { processStart: processStartTime(process.pid) } : {}), time: Date.now() } satisfies WriterIdentity),
          { mode: 0o600 }
        );
        return "new";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const existing = readFileSync(hashPath(dir), "utf8");
      return existing === hash ? "existing" : "conflict";
    },
    async append(id, event) {
      const dir = requestDir(root, id);
      if (typeof event !== "object" || event === null) {
        throw new Error("journal event must be an object");
      }
      validateEventShape(event as unknown as Record<string, unknown>);
      const current = readEvents(dir);
      if (current.length === 0 && event.seq !== 0) {
        throw new Error(`first journal event must have seq 0, got ${event.seq}`);
      }
      if (current.length > 0 && current[current.length - 1]!.seq + 1 !== event.seq) {
        throw new Error(
          `journal append sequence gap: expected ${current[current.length - 1]!.seq + 1}, got ${event.seq}`
        );
      }
      writeFileSync(eventsPath(dir), `${JSON.stringify(event, eventReplacer)}\n`, { flag: "a", mode: 0o600 });
    },
    async read(id) {
      const dir = requestDir(root, id);
      if (!existsSync(dir)) {
        throw new Error(`no journal record for request ${id}`);
      }
      const events = readEvents(dir);
      const hash = readFileSync(hashPath(dir), "utf8");
      let status = statusFromEvents(events);
      if (status === "running") {
        // Dead-writer recovery (F8): a writer that provably died left an
        // unterminated request — its delivery state is UNKNOWN, never
        // "still running", and it is never re-executed automatically. The
        // recovery mkdir serializes two readers so they cannot append two
        // terminal events with the same sequence number.
        const writer = readWriter(dir);
        if (writer !== null && writerIsDead(writer)) {
          const recoveryPath = join(dir, "recovery.lock");
          let recoveryOwner = false;
          // A loser never writes. It waits briefly for the winner to append
          // and release the lock; if the owner remains uncertain, callers get
          // an explicit recovery-in-progress error instead of two terminal
          // events with the same sequence number.
          for (let attempt = 0; attempt < 20; attempt++) {
            try {
              mkdirSync(recoveryPath, { mode: 0o700 });
              recoveryOwner = true;
              break;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            }
            const currentEvents = readEvents(dir);
            status = statusFromEvents(currentEvents);
            events.splice(0, events.length, ...currentEvents);
            if (status !== "running") break;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          if (recoveryOwner) {
            try {
              const currentEvents = readEvents(dir);
              status = statusFromEvents(currentEvents);
              events.splice(0, events.length, ...currentEvents);
              if (status === "running") {
                const terminalEvent: RequestEvent = {
                  seq: events.length,
                  time: Date.now(),
                  type: "request_finished",
                  payload: { status: "unknown", reason: "writer_gone" }
                };
                writeFileSync(eventsPath(dir), `${JSON.stringify(terminalEvent, eventReplacer)}\n`, {
                  flag: "a",
                  mode: 0o600
                });
                events.push(terminalEvent);
                status = "unknown";
              }
            } finally {
              rmSync(recoveryPath, { recursive: true, force: true });
            }
          } else if (status === "running") {
            throw new Error(`journal recovery in progress for request ${id}; terminal ownership is not proven`);
          }
        }
      }
      const record: RequestRecord = { hash, status, events };
      const finished = events.find((e) => e.type === "request_finished");
      if (finished && finished.payload.result !== undefined) {
        record.result = finished.payload.result;
      }
      return record;
    }
  };
}

/** Canonical operation hash for dedup (B3): normalized operation content +
 * target + schema version; generation/requestId never participate. */
export function canonicalRequestHash(parts: {
  kind: string;
  target: { pid: number; windowId: string | bigint };
  operation: unknown;
}): string {
  const normalized = JSON.stringify(
    {
      kind: parts.kind,
      target: { pid: parts.target.pid, windowId: String(parts.target.windowId) },
      operation: parts.operation
    },
    (_key, value) => (typeof value === "bigint" ? value.toString() : value)
  );
  // djb2-style rolling hash is enough for dedup (not security).
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized.charCodeAt(i);
    h1 = ((h1 ^ c) * 0x01000193) >>> 0;
    h2 = ((h2 + c * 31) ^ (h2 << 5)) >>> 0;
  }
  return `${h1.toString(16)}${h2.toString(16)}${normalized.length.toString(16)}`;
}

export { randomUUID as journalRandomId };
