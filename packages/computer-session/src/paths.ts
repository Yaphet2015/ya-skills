// Session-private directory layout (B1): UUID-only ids, a short 0700 socket
// directory under the user's temp root (full socket path <= 90 bytes), and
// per-session records in the user cache. Path construction happens ONLY
// here — callers never concatenate user strings into paths.

import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SessionPaths {
  directory: string;
  socket: string;
  metadata: string;
  events: string;
}

export function validateSessionId(id: string): string {
  if (!SESSION_ID_RE.test(id)) {
    throw new Error(`session id must be a UUID (got: ${id})`);
  }
  return id;
}

export function sessionRoot(root?: string): string {
  return root ?? join(homedir(), "Library", "Caches", "ya-skills", "computer-use", "sessions");
}

/** Socket directories must stay SHORT (sun_path is ~104 bytes): they live in
 * a per-user temp dir, not the deeper cache tree. */
export function socketRoot(root?: string): string {
  return root ?? join(tmpdir(), `ya-skills-cu-${process.env.USER ?? "user"}`);
}

export function sessionPaths(root: string, id: string): SessionPaths {
  validateSessionId(id);
  const directory = join(root, id);
  return {
    directory,
    // 12 hex chars (48 bits) keep the full path <= 90 bytes even on long
    // macOS temp roots; bind collisions fail loud (EADDRINUSE).
    socket: join(socketRoot(), `s-${id.replace(/-/g, "").slice(0, 12)}.sock`),
    metadata: join(directory, "session.json"),
    events: join(directory, "events.jsonl")
  };
}

export function assertSocketPathLength(socketPath: string): string {
  if (socketPath.length > 90) {
    throw new Error(
      `socket path too long for a Unix socket (${socketPath.length} > 90 bytes): ${socketPath}`
    );
  }
  return socketPath;
}
