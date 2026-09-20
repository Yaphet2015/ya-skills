// Shared process selection, launch and group cleanup for disposable workers.
// Keep this module dependency-free so Node can reject unsupported launches.

import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

export type InternalEntrypoint =
  | "__computer-session-host"
  | "__computer-driver-worker"
  | "__computer-exec-worker"
  | "__computer-e2e-worker";

export interface SpawnCommand {
  command: string;
  args: string[];
  runtime: "compiled" | "bun" | "node";
}

export function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

/** Resolve one internal worker to the compiled executable or Bun plus the
 * absolute CLI source. Node never gets as far as source resolution. */
export function internalSpawnCommand(entrypoint: InternalEntrypoint, configPath: string): SpawnCommand {
  if (!isAbsolute(configPath)) {
    throw new Error(`internal entrypoint config path must be absolute (got: ${configPath})`);
  }
  const bun = (globalThis as { Bun?: { main?: string } }).Bun;
  const main = bun?.main;
  if (main && typeof process.execPath === "string") {
    const compiled = main.includes("$bunfs") || realpathSyncSafe(main) === realpathSyncSafe(process.execPath);
    if (compiled) {
      return { command: realpathSync(process.execPath), args: [entrypoint, configPath], runtime: "compiled" };
    }
    return { command: process.execPath, args: [cliSourcePath(), entrypoint, configPath], runtime: "bun" };
  }
  throw Object.assign(
    new Error(
      "internal workers require the compiled yk or a Bun runtime; this process runs under Node — install ya-skills or run via bun"
    ),
    { code: "unsupported_runtime" }
  );
}

function realpathSyncSafe(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function cliSourcePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = join(here, "..", "..", "cli", "src", "cli.ts");
  if (existsSync(candidate)) return candidate;
  throw new Error(`unable to locate the CLI source beside the session package (tried ${candidate})`);
}

export interface SpawnedWorker {
  child: ChildProcess;
  cwd: string;
}

export interface WorkerSpawnOptions {
  cwd: string;
  stdio: SpawnOptions["stdio"];
  env?: NodeJS.ProcessEnv;
}

function spawnResolvedWorker(command: SpawnCommand, options: WorkerSpawnOptions): ChildProcess {
  return spawn(command.command, command.args, {
    detached: true,
    cwd: options.cwd,
    stdio: options.stdio,
    env: { ...process.env, ...options.env }
  });
}

/** Spawn a selected internal worker without retrying. Persistent host/driver
 * callers use this direct path because they need the child immediately. */
export function spawnWorker(
  entrypoint: InternalEntrypoint,
  configPath: string,
  options: WorkerSpawnOptions
): ChildProcess {
  return spawnResolvedWorker(internalSpawnCommand(entrypoint, configPath), options);
}

// Bun can transiently fail while wiring several numeric stdio descriptors.
// Serializing these disposable launches and retrying before any child exists
// avoids replaying a worker request.
let spawnTail: Promise<void> = Promise.resolve();

export async function spawnWorkerWithRetry(
  entrypoint: InternalEntrypoint,
  configPath: string,
  options: WorkerSpawnOptions
): Promise<ChildProcess> {
  // Resolve the runtime once. Unsupported Node callers fail before the retry
  // loop, source lookup or any child spawn, preserving the internal-worker
  // boundary.
  const command = internalSpawnCommand(entrypoint, configPath);
  const previous = spawnTail;
  let release!: () => void;
  spawnTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  let lastError: unknown;
  try {
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        return spawnResolvedWorker(command, options);
      } catch (error) {
        lastError = error;
        if (attempt < 11) await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  } finally {
    release();
  }
}

/** Spawn a worker in a private 0700 cwd. The E2E supervisor deliberately uses
 * spawnWorkerWithRetry with the project cwd; exec uses its private boot cwd
 * and changes to the script cwd only after worker boot. */
export function spawnInternalWorker(
  entrypoint: InternalEntrypoint,
  configPath: string,
  options: { env?: Record<string, string>; stdio?: "pipe" | "ignore" } = {}
): SpawnedWorker {
  const cwd = mkdtempSync(join(tmpdir(), "yk-cu-worker-"));
  const child = spawnWorker(entrypoint, configPath, {
    cwd,
    stdio: options.stdio === "ignore" ? "ignore" : ["pipe", "pipe", "pipe"],
    env: options.env
  });
  child.on("error", () => undefined);
  return { child, cwd };
}

export function closeOwnedFd(fd: number): void {
  try {
    closeSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EBADF") throw error;
  }
}

export interface StopResult {
  exited: boolean;
  signal: NodeJS.Signals | null;
  code: number | null;
  /** Group members survived SIGKILL escalation (exited:false only). */
  groupSurvivors: number | null;
}

function groupHasRunnableMember(pgid: number): boolean {
  const ps = spawnSync("ps", ["-axo", "pgid=,stat="], { encoding: "utf8" });
  if (ps.status !== 0) return true;
  for (const line of (ps.stdout ?? "").split("\n")) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (match && Number(match[1]) === pgid && !match[2]!.startsWith("Z")) return true;
  }
  return false;
}

/** TERM the process group, wait the grace period, then KILL. Completion is a
 * proof about the whole group, including descendants after the leader exits. */
export function stopProcessGroup(child: ChildProcess, graceMs: number): Promise<StopResult> {
  return new Promise((resolve) => {
    const pgid = child.pid;
    if (pgid === undefined) {
      resolve({ exited: true, signal: null, code: null, groupSurvivors: null });
      return;
    }
    let settled = false;
    let leaderExited = false;
    let leaderCode: number | null = null;
    let leaderSignal: NodeJS.Signals | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    const clearGrace = (): void => {
      if (graceTimer !== null) clearTimeout(graceTimer);
    };
    const finish = (result: StopResult): void => {
      if (settled) return;
      settled = true;
      clearGrace();
      resolve(result);
    };
    const killGroup = (name: NodeJS.Signals): void => {
      try {
        process.kill(-pgid, name);
      } catch {
        // ESRCH: the group is already gone.
      }
    };
    const groupAlive = (): boolean => {
      try {
        process.kill(-pgid, 0);
        return groupHasRunnableMember(pgid);
      } catch (error) {
        // EPERM: members exist but are not ours — still alive.
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    };
    let escalated = false;
    const settle = async (): Promise<void> => {
      const deadline = Date.now() + Math.max(graceMs, 2_000);
      for (;;) {
        if (!groupAlive()) {
          finish({
            exited: true,
            signal: leaderExited ? leaderSignal : "SIGKILL",
            code: leaderExited ? leaderCode : null,
            groupSurvivors: null
          });
          return;
        }
        if (!escalated) {
          escalated = true;
          killGroup("SIGKILL");
        }
        if (Date.now() >= deadline) {
          finish({ exited: false, signal: null, code: null, groupSurvivors: pgid });
          return;
        }
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
      }
    };
    const onLeaderExit = (code: number | null, signalName: NodeJS.Signals | null): void => {
      leaderExited = true;
      leaderCode = code;
      leaderSignal = signalName;
      void settle();
    };
    if (child.exitCode !== null || child.signalCode !== null) {
      onLeaderExit(child.exitCode, child.signalCode);
    } else {
      child.once("exit", onLeaderExit);
    }
    // An already-exited group can settle synchronously above. Do not create
    // a grace timer after finish() has already disposed the cleanup lifetime.
    if (settled) return;
    killGroup("SIGTERM");
    graceTimer = setTimeout(() => {
      if (!leaderExited) killGroup("SIGKILL");
      void settle();
    }, graceMs);
  });
}

export const TERM_GRACE_MS = 2_000;
