// openSession (B4): spawn the dedicated session host process and wait until
// its socket answers `status` with an idle/stopping state. The host config
// is written by this module (0600, private temp dir) — it never comes from
// user input paths.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sendControl } from "./client.js";
import { sessionPaths, sessionRoot, socketRoot } from "./paths.js";
import { spawnInternalWorker, stopProcessGroup } from "./process.js";
import type { SessionInfo } from "./types.js";
import { mkdirSync } from "node:fs";

export interface OpenSessionOptions {
  target: { pid: number; windowId: bigint };
  root?: string;
  idleTimeoutMs?: number;
  /** Internal tests only: inject the fake driver module. */
  driverModule?: { path: string; export?: string };
}

export interface OpenedSession {
  info: SessionInfo;
  socketPath: string;
  configPath: string;
  hostPid: number;
}

const BOOT_TIMEOUT_MS = 20_000;

export async function openSession(options: OpenSessionOptions): Promise<OpenedSession> {
  const sessionId = randomUUID();
  const generation = randomUUID();
  const root = sessionRoot(options.root);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(socketRoot(), { recursive: true, mode: 0o700 });
  const paths = sessionPaths(root, sessionId);
  const configDir = await mkdtemp(join(tmpdir(), "yk-cu-hostcfg-"));
  const configPath = join(configDir, "host.json");
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      sessionId,
      generation,
      target: { pid: options.target.pid, windowId: options.target.windowId.toString() },
      root,
      socketPath: paths.socket,
      idleTimeoutMs: options.idleTimeoutMs ?? 120_000,
      // Per-session request journal (F7): request ids and events NEVER cross
      // session boundaries — only the application leases live in the shared
      // root (root/leases).
      requestsDir: join(paths.directory, "requests"),
      ...(options.driverModule ? { driver: { kind: "module", path: options.driverModule.path, export: options.driverModule.export } } : {})
    }),
    { mode: 0o600 }
  );
  const { child } = spawnInternalWorker("__computer-session-host", configPath);
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let lastError: unknown = null;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      await rm(configDir, { recursive: true, force: true }).catch(() => undefined);
      throw new Error(`session host exited during startup (code=${child.exitCode} signal=${child.signalCode})`);
    }
    try {
      const reply = await sendControl(paths.socket, { kind: "status", schemaVersion: 1, sessionId }, 1_000);
      if (reply.info) {
        return { info: reply.info, socketPath: paths.socket, configPath, hostPid: child.pid! };
      }
      lastError = reply.error;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) {
      await stopProcessGroup(child, 2_000);
      await rm(configDir, { recursive: true, force: true }).catch(() => undefined);
      throw new Error(`session host did not become ready in ${BOOT_TIMEOUT_MS}ms: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/** Locate an existing session by id: reads the metadata the host maintains. */
export async function findSession(sessionId: string, root?: string): Promise<{ socketPath: string; info: SessionInfo } | null> {
  const { readFile } = await import("node:fs/promises");
  const paths = sessionPaths(sessionRoot(root), sessionId);
  try {
    const info = JSON.parse(await readFile(paths.metadata, "utf8")) as SessionInfo;
    return { socketPath: paths.socket, info };
  } catch {
    return null;
  }
}
