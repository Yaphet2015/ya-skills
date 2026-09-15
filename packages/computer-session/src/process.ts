// Self-spawn process management (B2/B4): chooses the command for internal
// worker entrypoints (compiled executable vs Bun + absolute source), spawns
// them in their own process groups with a private cwd, and reclaims them
// with TERM→KILL. No Node-runtime fallback exists for these entrypoints —
// Node builds refuse with unsupported_runtime before spawning anything.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

export type InternalEntrypoint =
  | "__computer-session-host"
  | "__computer-driver-worker"
  | "__computer-exec-worker";

export interface SpawnCommand {
  command: string;
  args: string[];
  runtime: "compiled" | "bun" | "node";
}

export function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

/** The spawn command for an internal entrypoint. Compiled mode: the
 * realpath'd executable IS the entry. Dev: the Bun binary plus the absolute
 * CLI source. A plain Node runtime cannot host these workers — the node
 * result is rejected HERE, before source-path resolution or spawning
 * anything (review F21). */
export function internalSpawnCommand(entrypoint: InternalEntrypoint, configPath: string): SpawnCommand {
  if (!isAbsolute(configPath)) {
    throw new Error(`internal entrypoint config path must be absolute (got: ${configPath})`);
  }
  const bun = (globalThis as { Bun?: { main?: string } }).Bun;
  const main = bun?.main;
  if (main && typeof process.execPath === "string") {
    // Are we the compiled binary? Bun.main resolves to the real script file
    // only in interpreted mode; compiled binaries point inside $bunfs.
    const compiled = main.includes("$bunfs") || realpathSyncSafe(main) === realpathSyncSafe(process.execPath);
    if (compiled) {
      return { command: realpathSync(process.execPath), args: [entrypoint, configPath], runtime: "compiled" };
    }
    return { command: process.execPath, args: [cliSourcePath(), entrypoint, configPath], runtime: "bun" };
  }
  // No Bun runtime: Node cannot interpret the TS CLI source nor host the
  // lazy-SDK Bun runtime — refuse explicitly BEFORE resolving/spawning.
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
  // src/process.ts -> packages/computer-session/src -> packages -> repo root
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = join(here, "..", "..", "cli", "src", "cli.ts");
  if (existsSync(candidate)) return candidate;
  throw new Error(`unable to locate the CLI source beside the session package (tried ${candidate})`);
}

export interface SpawnedWorker {
  child: ChildProcess;
  cwd: string;
}

/** Spawn an internal worker: own process group, private 0700 cwd (never the
 * source checkout, so no project preload runs), pipes for the boot/upstream
 * protocol. */
export function spawnInternalWorker(
  entrypoint: InternalEntrypoint,
  configPath: string,
  options: { env?: Record<string, string> } = {}
): SpawnedWorker {
  const { command, args } = internalSpawnCommand(entrypoint, configPath);
  if (
    (command === process.execPath && !isBunRuntime() && !existsSync(command)) ||
    (!isBunRuntime() && !command.includes("bun"))
  ) {
    throw Object.assign(new Error("internal workers require the compiled yk or a Bun runtime"), {
      code: "unsupported_runtime"
    });
  }
  const cwd = mkdtempSync(join(tmpdir(), "yk-cu-worker-"));
  const child = spawn(command, args, {
    detached: true, // own process group — kill(-pid) reaps descendants
    stdio: ["pipe", "pipe", "pipe"],
    cwd,
    env: { ...process.env, ...options.env }
  });
  child.on("error", () => undefined);
  return { child, cwd };
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

/** TERM the process group, wait the grace period, then KILL. Resolution
 * requires the WHOLE GROUP to be gone, not just the leader: a descendant
 * that ignores TERM is escalated after the leader exits (F4). `exited:false`
 * means members survived both signals — the caller must treat the target as
 * un-reclaimable, never reuse it. */
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
    const clearGrace = () => {
      if (graceTimer !== null) clearTimeout(graceTimer);
    };
    const finish = (result: StopResult) => {
      if (settled) return;
      settled = true;
      clearGrace();
      resolve(result);
    };
    const killGroup = (name: NodeJS.Signals) => {
      try {
        process.kill(-pgid, name);
      } catch {
        // ESRCH: the group is already gone
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
    // Settling requires the WHOLE group to be gone (F4). Survivors are
    // escalated with SIGKILL once; a bounded verification window follows.
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
      // Leader exit alone proves nothing about the group (F4).
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
    killGroup("SIGTERM");
    graceTimer = setTimeout(() => {
      if (!leaderExited) killGroup("SIGKILL");
      void settle();
    }, graceMs);
  });
}

export const TERM_GRACE_MS = 2_000;
